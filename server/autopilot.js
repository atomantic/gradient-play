import { getGameSnapshot, sendAssistantPrompt } from './cdp.js';

const DEFAULTS = {
  pollIntervalSec: 60,
  minWarp: 50,                    // below this: refuel
  bankReserveMin: 25000,          // strategy.md: ~1x Kestrel replacement cost
  onHandFloor: 2000,              // never drain on-hand below this via deposits
  decisionCooldownSec: 420,       // 7 min — longer than a typical refuel or task handoff
  exploreMaxHops: 40,
  considerUpgrades: true,
  upgradeCreditsThreshold: 100000, // remind the agent to check upgrades when total hits this
  enabled: {
    refuel: true,
    explore: true,
    trade: true,
    bank: true,
    upgrade: true
  }
};

const state = {
  running: false,
  config: null,
  startedAt: null,
  timer: null,
  log: [],
  lastDecisionAt: new Map(),
  lastSnapshot: null,
  subscribers: new Set()
};

const appendLog = (entry) => {
  const stamped = { ts: Date.now(), ...entry };
  state.log.push(stamped);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  for (const fn of state.subscribers) fn(stamped);
};

const shipKind = (name = '') => {
  const n = name.toUpperCase();
  if (/PROBE/.test(n)) return 'probe';
  if (/HAULER|FREIGHTER|LIFTER|ATLAS|PIONEER|WAYFARER/.test(n)) return 'hauler';
  if (/KESTREL|SPARROW|COURIER/.test(n)) return 'trader-light';
  if (/CORSAIR|PIKE|BULWARK|AEGIS|SOVEREIGN|RAIDER|FRIGATE|DESTROYER|CRUISER/.test(n)) return 'combat';
  return 'unknown';
};

// Next upgrade tier by current ship class, from strategy.md.
// price = next tier cost (before trade-in; we use it as a target only).
const NEXT_UPGRADE = {
  SPARROW: { name: 'Kestrel Courier', price: 25000 },
  KESTREL: { name: 'Wayfarer Freighter', price: 120000 },
  WAYFARER: { name: 'Pioneer Lifter', price: 220000 },
  PIONEER: { name: 'Atlas Hauler', price: 260000 },
  ATLAS: { name: 'Sovereign Starcruiser', price: 2500000 },
  CORSAIR: { name: 'Pike Frigate', price: 300000 },
  PIKE: { name: 'Bulwark Destroyer', price: 450000 },
  BULWARK: { name: 'Aegis Cruiser', price: 700000 },
  AEGIS: { name: 'Sovereign Starcruiser', price: 2500000 }
};

const findNextUpgrade = (shipName = '') => {
  const n = shipName.toUpperCase();
  for (const key of Object.keys(NEXT_UPGRADE)) {
    if (n.includes(key)) return NEXT_UPGRADE[key];
  }
  return null;
};

const canAct = (key, cooldownMs) => {
  const prev = state.lastDecisionAt.get(key) || 0;
  return Date.now() - prev >= cooldownMs;
};

/**
 * Inspect snapshot and return a list of { key, text, ship? } decisions.
 * Caller applies cooldown dedup and sends prompts.
 */
const decide = (snapshot) => {
  const cfg = state.config;
  const ex = snapshot?.extracted || {};
  const ships = ex.ships || [];
  const out = [];
  const cooldownMs = cfg.decisionCooldownSec * 1000;

  for (const s of ships) {
    // Refuel guard: warp below floor → one refuel prompt per ship, with longer cooldown.
    if (cfg.enabled.refuel && s.warpPower != null && s.warpPower < cfg.minWarp) {
      const key = `refuel:${s.name}`;
      if (canAct(key, cooldownMs)) {
        out.push({
          key,
          ship: s.name,
          text: `Heads up — the ${s.name} is down to ${s.warpPower} warp. Pull it off whatever it's doing, route to the nearest megaport, and recharge before it gets stranded.`
        });
      }
      continue; // don't stack a trade order on a low-fuel ship this tick
    }

    if (s.primary) continue; // Kestrel idleness isn't reliably inferable from DOM — user drives it

    if (s.active === true) continue; // corp ship already on a task

    // Corp ship idle → dispatch based on kind.
    const kind = shipKind(s.name);
    if (kind === 'probe' && cfg.enabled.explore) {
      const key = `explore:${s.name}`;
      if (canAct(key, cooldownMs)) {
        out.push({
          key,
          ship: s.name,
          text: `The ${s.name} is idle — put it on an exploration task: visit every unvisited sector within ${cfg.exploreMaxHops} hops of its current position.`
        });
      }
    } else if ((kind === 'hauler' || kind === 'trader-light') && cfg.enabled.trade) {
      const key = `trade:${s.name}`;
      if (canAct(key, cooldownMs)) {
        out.push({
          key,
          ship: s.name,
          text: `The ${s.name} is idle — start an autonomous trade task on it. Find a profitable 2–3 hop NS loop near its current sector and run it. Refuel at a megaport if warp dips low.`
        });
      }
    }
  }

  // Bank reserve: if bank is under target and we have enough on-hand to spare, deposit.
  if (cfg.enabled.bank) {
    const bank = ex.creditsBank ?? 0;
    const onHand = ex.creditsOnHand ?? 0;
    const need = cfg.bankReserveMin - bank;
    const spare = onHand - cfg.onHandFloor;
    if (need > 0 && spare >= 500) {
      const amount = Math.min(need, spare);
      const key = 'bank:reserve';
      if (canAct(key, cooldownMs)) {
        out.push({
          key,
          text: `Next time you're at a megaport, drop ${amount} credits in the bank — we want at least ${cfg.bankReserveMin} tucked away in case anything gets destroyed.`
        });
      }
    }
  }

  // Upgrade: only fire when (a) we know the primary ship's next tier and (b) we can
  // actually afford it while keeping the bank reserve. Ship ladder lives in code
  // (from strategy.md) so we don't ask the agent to look anything up.
  if (cfg.enabled.upgrade && cfg.considerUpgrades && ex.shipName) {
    const next = findNextUpgrade(ex.shipName);
    const bank = ex.creditsBank ?? 0;
    const onHand = ex.creditsOnHand ?? 0;
    const total = bank + onHand;
    if (next && total >= next.price && bank >= cfg.bankReserveMin) {
      const key = `upgrade:${next.name}`;
      if (canAct(key, cooldownMs * 2)) {
        out.push({
          key,
          text: `We've got ${total} credits — enough to trade up to a ${next.name} (${next.price}). When the ${ex.shipName} next hits a megaport, trade it in and buy the ${next.name}, then get back to trading in the new hull.`
        });
      }
    }
  }

  return out;
};

const runTick = async () => {
  if (!state.running) return;
  try {
    const snapshot = await getGameSnapshot();
    state.lastSnapshot = snapshot;
    const decisions = decide(snapshot);

    appendLog({
      type: 'tick',
      snapshot: snapshot?.extracted ? {
        ships: (snapshot.extracted.ships || []).map((s) => ({
          name: s.name, warp: s.warpPower, sector: s.sector, active: s.active, primary: s.primary
        })),
        creditsBank: snapshot.extracted.creditsBank,
        creditsOnHand: snapshot.extracted.creditsOnHand,
        anyTaskWorking: snapshot.extracted.anyTaskWorking,
        tasksRunning: (snapshot.extracted.tasks || []).filter((t) => t.working).length
      } : null,
      decisionCount: decisions.length
    });

    for (const d of decisions) {
      const send = await sendAssistantPrompt(d.text).catch((e) => ({ ok: false, error: e.message }));
      state.lastDecisionAt.set(d.key, Date.now());
      appendLog({ type: 'decision', key: d.key, ship: d.ship, text: d.text, send });
    }
  } catch (err) {
    appendLog({ type: 'error', error: err.message });
  } finally {
    if (state.running) {
      state.timer = setTimeout(runTick, state.config.pollIntervalSec * 1000);
    }
  }
};

export const startAutopilot = (config = {}) => {
  if (state.running) return { ok: false, error: 'already running' };
  state.config = {
    ...DEFAULTS,
    ...config,
    enabled: { ...DEFAULTS.enabled, ...(config.enabled || {}) }
  };
  state.running = true;
  state.startedAt = Date.now();
  state.lastDecisionAt.clear();
  state.log.length = 0;
  appendLog({ type: 'start', config: state.config });
  runTick();
  return { ok: true, config: state.config };
};

export const stopAutopilot = () => {
  if (!state.running) return { ok: false, error: 'not running' };
  state.running = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  appendLog({ type: 'stop' });
  return { ok: true };
};

export const getAutopilotState = () => ({
  running: state.running,
  config: state.config,
  startedAt: state.startedAt,
  lastSnapshot: state.lastSnapshot?.extracted || null,
  log: state.log.slice(-200),
  lastDecisions: Object.fromEntries(state.lastDecisionAt)
});

export const subscribeAutopilotLog = (fn) => {
  state.subscribers.add(fn);
  return () => state.subscribers.delete(fn);
};
