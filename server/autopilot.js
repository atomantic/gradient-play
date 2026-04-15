import { getGameSnapshot, sendAssistantPrompt } from './cdp.js';
import { observe as intelObserve } from './intel.js';

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
  seenEventKeys: new Set(),
  lastSnapshot: null,
  subscribers: new Set()
};

/**
 * Patterns of assistant chat messages that tell us an autonomous task has
 * ended or state has changed materially. Each matches a "role" word
 * (hauler/probe/kestrel/courier) that we map to a concrete ship name.
 */
const EVENT_PATTERNS = [
  {
    type: 'task-max-steps',
    re: /the (\w+)(?:['\u2019]s)?\s*(?:current\s+)?(?:autonomous\s+)?task\s+(?:has\s+)?ended\s+after\s+reaching\s+its\s+maximum\s+allowed\s+steps/i,
    clearsCooldownFor: ['trade', 'explore']
  },
  {
    type: 'task-aborted',
    re: /(?:the\s+)?(\w+)(?:['\u2019]s)?\s+(?:autonomous\s+)?task\s+(?:has\s+been\s+|was\s+)?aborted/i,
    clearsCooldownFor: ['trade', 'explore']
  },
  {
    type: 'task-completed',
    re: /(?:the\s+)?(\w+)(?:['\u2019]s)?\s+(?:autonomous\s+)?task\s+(?:has\s+)?completed/i,
    clearsCooldownFor: ['trade', 'explore']
  }
];

const matchShipByRole = (roleWord = '', ships = []) => {
  const w = roleWord.toLowerCase();
  // Specific names first — if the assistant said "SA-ME" try to match it literally.
  const direct = ships.find((s) => s.name.toLowerCase().includes(w));
  if (direct) return direct;
  if (/probe/.test(w)) return ships.find((s) => /PROBE/i.test(s.name));
  if (/hauler|freighter|lifter|atlas|pioneer|wayfarer/.test(w)) {
    return ships.find((s) => /HAULER|FREIGHTER|LIFTER|ATLAS|PIONEER|WAYFARER/i.test(s.name));
  }
  if (/kestrel|courier|ship/.test(w)) return ships.find((s) => s.primary);
  return null;
};

const parseAssistantEvents = (snapshot) => {
  const msgs = snapshot?.extracted?.lastMessages || [];
  const ships = snapshot?.extracted?.ships || [];
  const events = [];
  for (const m of msgs) {
    if (!m) continue;
    const tsMatch = m.match(/\[(\d{2}:\d{2}:\d{2})\]/);
    const msgTs = tsMatch ? tsMatch[1] : null;
    // Only parse assistant prose (FUNCTION CALL / USER lines are noise here).
    if (!/ASSISTANT[:\s]/i.test(m)) continue;
    for (const pat of EVENT_PATTERNS) {
      const match = m.match(pat.re);
      if (!match) continue;
      const ship = matchShipByRole(match[1], ships);
      if (!ship) continue;
      const key = `${pat.type}:${ship.name}:${msgTs || m.slice(0, 40)}`;
      if (state.seenEventKeys.has(key)) continue;
      state.seenEventKeys.add(key);
      events.push({
        type: pat.type,
        ship: ship.name,
        roleWord: match[1],
        msgTs,
        snippet: m.replace(/\s+/g, ' ').slice(0, 200),
        clearsCooldownFor: pat.clearsCooldownFor
      });
    }
  }
  return events;
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

    // Threat intel — detect destructions / hostile chat events.
    const intelEvents = intelObserve(snapshot);
    for (const ev of intelEvents) {
      appendLog({ type: 'intel', intelType: ev.type, ship: ev.ship, attacker: ev.attacker, sector: ev.sector });
    }

    // Chat-event scan: if the assistant reported "task ended after max steps"
    // (or similar) for a specific ship, clear that ship's cooldown keys so
    // decide() re-dispatches on this same tick.
    const events = parseAssistantEvents(snapshot);
    for (const ev of events) {
      appendLog({ type: 'event', ...ev });
      for (const prefix of ev.clearsCooldownFor || []) {
        state.lastDecisionAt.delete(`${prefix}:${ev.ship}`);
      }
    }

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
  state.seenEventKeys.clear();
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
