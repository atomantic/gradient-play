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
          text: `The ${s.name} is sitting idle. Kick off an exploration task on it: visit every unvisited sector within ${cfg.exploreMaxHops} hops of its current position, and report progress as it goes.`
        });
      }
    } else if ((kind === 'hauler' || kind === 'trader-light') && cfg.enabled.trade) {
      const key = `trade:${s.name}`;
      if (canAct(key, cooldownMs)) {
        out.push({
          key,
          ship: s.name,
          text: `The ${s.name} is idle. Start an autonomous trade task on it — find a profitable 2–3 hop NS loop near its current sector and run it continuously. Refuel at a megaport if warp drops below 100.`
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
          text: `When you next dock at a megaport, deposit ${amount} credits into the bank — we want to keep at least ${cfg.bankReserveMin} in reserve as insurance against getting destroyed.`
        });
      }
    }
  }

  // Upgrade reminder: if we're sitting on enough credits, nudge a check.
  if (cfg.enabled.upgrade && cfg.considerUpgrades) {
    const total = (ex.creditsBank ?? 0) + (ex.creditsOnHand ?? 0);
    if (total >= cfg.upgradeCreditsThreshold) {
      const key = 'upgrade:check';
      if (canAct(key, cooldownMs * 2)) {
        out.push({
          key,
          text: `We're sitting on ${total} total credits. Check if the ${ex.shipName || 'current ship'} has a worthwhile upgrade available — if we can afford the next tier and keep at least ${cfg.bankReserveMin} in the bank as reserve, head to a megaport, trade in, and purchase it.`
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
