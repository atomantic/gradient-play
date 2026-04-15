import { getGameSnapshot, sendAssistantPrompt } from './cdp.js';
import { observe as intelObserve, dangerousSectors } from './intel.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const safeRoutingClause = () => {
  const bad = dangerousSectors();
  if (!bad.length) return '';
  const list = bad.slice(0, 8).join(', ');
  return pick([
    ` try to avoid sectors ${list} (we lost ships there), but if warp is too low just go to the closest megaport, getting stranded is worse.`,
    ` route around ${list} if you can, we lost ships in those sectors. but dont get stranded, any megaport is better than empty space.`,
    ` steer clear of ${list} if possible (bad history there), otherwise closest megaport wins.`
  ]);
};

const refuelPrompt = (ship, warp) => pick([
  `hey, ${ship} is down to ${warp} warp. pull it off whatever its doing and send it to a safe megaport to recharge.` + safeRoutingClause(),
  `${ship} fuel is low, ${warp} warp left. break off its task and route to a megaport to top off.` + safeRoutingClause(),
  `fuel check on ${ship}, ${warp} warp. recall to a megaport and recharge before it strands.` + safeRoutingClause()
]);

const probeExplorePrompt = (probe, hops) => pick([
  `${probe} is idle, send it out on explore and salvage. map unvisited sectors within ${hops} hops, check every sector for salvage on arrival (900s ttl), deposit credits at megaports. flee any combat. probes are disposable, deep space is fine, just dont linger in hostile sectors.`,
  `put ${probe} back to work. explore and salvage duty, ${hops} hop radius of unmapped space. claim any salvage you find, bank credits whenever you dock. flee fights. probes are cheap so deep space is ok.`,
  `${probe} needs a job. scout unmapped space out to ${hops} hops, grab salvage where you find it, drop credits at megaports. dont stick around in known hostile sectors.`
]);

const haulerTradePrompt = (hauler) => pick([
  `${hauler} is idle, start a trade task. stick to fedspace or sectors right next to it, no deep neutral space. we cant replace a lost hauler right now. find a 2-3 hop NS loop and run it. refuel at megaports when warp gets low.` + safeRoutingClause(),
  `put ${hauler} on a short NS trade loop, fedspace or adjacent only. no contested territory without a corsair to back us up. refuel as needed.` + safeRoutingClause(),
  `${hauler} needs a run. 2-3 hop NS loop somewhere near fedspace, stay safe, refuel when warp dips.` + safeRoutingClause()
]);

const bankSweepPrompt = (excess, onHand, floor) => pick([
  `next time you dock at a megaport, deposit ${excess} credits in the bank. we have ${onHand} on hand but only need about ${floor} for working capital. anything extra on the ship is just destruction risk.`,
  `bank sweep time. sitting on ${onHand} on hand, ${excess} above our ${floor} working floor. drop the excess in the bank on the next megaport stop.`,
  `lets bank the extra. ${excess} over what we need is just at risk. deposit on your next dock.`
]);

const upgradePrompt = (shipName, total, next) => pick([
  `we have ${total} credits, enough for a ${next.name} at ${next.price}. when the ${shipName} next docks, trade it in and pick up the ${next.name}, then get back to trading.`,
  `upgrade ready. ${total} credits means we can afford the ${next.name} (${next.price}). swap the ${shipName} for it at the next megaport.`,
  `time to trade up. ${total} on hand + banked, and the ${next.name} is ${next.price}. next megaport, swap ${shipName} for the new hull and resume.`
]);

const primaryTradePrompt = (primary) => pick([
  `start a short NS trade loop for the ${primary}, fedspace only. 2-3 hops, refuel when warp gets low. fedspace is pvp safe so just go for margin.`,
  `put the ${primary} on a trade loop in fedspace. stick to federation sectors, pick the best NS margin you can find, refuel as needed.`,
  `${primary} trade loop please, federation space only. short NS hops. no border or neutral zones.`
]);

const DEFAULTS = {
  pollIntervalSec: 60,
  minWarp: 50,                    // below this: refuel
  onHandFloor: 5000,              // working capital to keep on-hand for trades + fuel
  depositExcessOver: 3000,        // if on-hand exceeds floor by this much, bank the difference
  decisionCooldownSec: 420,       // 7 min — longer than a typical refuel or task handoff
  exploreMaxHops: 40,
  considerUpgrades: true,
  upgradeCreditsThreshold: 100000,
  corpTaskCap: 3,                 // fallback if DOM taskSlots.total isn't reported
  primaryDispatchCooldownSec: 300,  // 5 min — tight enough to refill the local slot quickly when a task ends
  enabled: {
    refuel: true,
    explore: true,
    trade: true,
    bank: true,
    upgrade: true,
    primary: true                 // keep the Kestrel working in fedspace trade
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
        isPrimary: !!ship.primary,
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

  // Refuel guard runs first for every ship (including active ones — a break-off
  // order to recharge supersedes any running task).
  for (const s of ships) {
    if (cfg.enabled.refuel && s.warpPower != null && s.warpPower < cfg.minWarp) {
      const key = `refuel:${s.name}`;
      if (canAct(key, cooldownMs)) {
        out.push({ key, ship: s.name, text: refuelPrompt(s.name, s.warpPower) });
      }
    }
  }

  // Role-balanced allocation for idle corp ships.
  //
  // The game exposes total task slots via "N/M SLOTS USED" (scraped as
  // ex.taskSlots). Typical fleet shows 4 total — 1 local (player) + 3 corp.
  // Use DOM's reported total when available, falling back to cfg.corpTaskCap.
  //
  // Strategy (per strategy.md):
  //   - Reserve 1 slot for a probe on explore/salvage (high map value).
  //   - Fill remaining corp slots with haulers on fedspace+adjacent trade loops.
  //   - Kestrel (primary) gets a separate periodic fedspace-trade dispatch below,
  //     occupying the local task engine slot.
  const corpShips = ships.filter((s) => !s.primary);
  const activeCorp = corpShips.filter((s) => s.active === true);
  const idleCorp = corpShips.filter((s) => s.active === false && s.warpPower != null && s.warpPower >= cfg.minWarp);

  const activeProbeCount = activeCorp.filter((s) => shipKind(s.name) === 'probe').length;
  const idleProbes = idleCorp.filter((s) => shipKind(s.name) === 'probe');
  const idleHaulers = idleCorp.filter((s) => ['hauler', 'trader-light'].includes(shipKind(s.name)));

  idleHaulers.sort((a, b) => (b.warpPower || 0) - (a.warpPower || 0));
  idleProbes.sort((a, b) => (b.warpPower || 0) - (a.warpPower || 0));

  // Derive cap from DOM if present (reserve 1 slot for primary/local tasks).
  // Example: taskSlots.total=4 → corpCap=3.
  const domTotal = ex.taskSlots?.total;
  const effectiveCorpCap = Math.min(
    cfg.corpTaskCap,
    domTotal != null ? Math.max(0, domTotal - 1) : Infinity
  );
  let remainingSlots = Math.max(0, effectiveCorpCap - activeCorp.length);

  // Reserve slot 1 for a probe (if no probe is already running and we have one idle).
  if (remainingSlots > 0 && cfg.enabled.explore && activeProbeCount === 0 && idleProbes.length > 0) {
    const probe = idleProbes[0];
    const key = `explore:${probe.name}`;
    if (canAct(key, cooldownMs)) {
      out.push({ key, ship: probe.name, text: probeExplorePrompt(probe.name, cfg.exploreMaxHops) });
      remainingSlots -= 1;
    }
  }

  // Fill remaining slots with haulers on safe trade loops.
  for (const hauler of idleHaulers) {
    if (remainingSlots <= 0) break;
    if (!cfg.enabled.trade) break;
    const key = `trade:${hauler.name}`;
    if (!canAct(key, cooldownMs)) continue;
    out.push({ key, ship: hauler.name, text: haulerTradePrompt(hauler.name) });
    remainingSlots -= 1;
  }

  // Bank excess on-hand aggressively. Anything above cfg.onHandFloor is working
  // capital risk — sweep it to the bank whenever we're docked. Runs independently
  // of the bank balance (the bank has no ceiling; on-hand is the danger).
  if (cfg.enabled.bank) {
    const onHand = ex.creditsOnHand ?? 0;
    const excess = onHand - cfg.onHandFloor;
    if (excess >= cfg.depositExcessOver) {
      const key = 'bank:sweep';
      if (canAct(key, cooldownMs)) {
        out.push({ key, text: bankSweepPrompt(excess, onHand, cfg.onHandFloor) });
      }
    }
  }

  // Upgrade: only fire when (a) we know the primary ship's next tier and (b) we can
  // actually afford it. Ship ladder lives in code (from strategy.md) so we don't
  // ask the agent to look anything up.
  if (cfg.enabled.upgrade && cfg.considerUpgrades && ex.shipName) {
    const next = findNextUpgrade(ex.shipName);
    const bank = ex.creditsBank ?? 0;
    const onHand = ex.creditsOnHand ?? 0;
    const total = bank + onHand;
    if (next && total >= next.price) {
      const key = `upgrade:${next.name}`;
      if (canAct(key, cooldownMs * 2)) {
        out.push({ key, text: upgradePrompt(ex.shipName, total, next) });
      }
    }
  }

  // Keep the local task engine (primary ship) slot in use.
  // We can tell from DOM whether the Kestrel already has a task: the task cards
  // list every working task, and corp ships mark themselves ACTIVE in the fleet
  // panel. If workingTaskCount > activeCorpShips, the extra task is the primary's.
  if (cfg.enabled.primary && ex.shipName) {
    const primary = ships.find((s) => s.primary);
    const workingTaskCount = (ex.tasks || []).filter((t) => t.working).length;
    const activeCorpCount = activeCorp.length;
    const primaryHasTask = workingTaskCount > activeCorpCount;

    if (
      primary &&
      !primaryHasTask &&
      primary.warpPower != null &&
      primary.warpPower >= cfg.minWarp
    ) {
      const key = 'primary:trade';
      if (canAct(key, cfg.primaryDispatchCooldownSec * 1000)) {
        out.push({ key, ship: primary.name, text: primaryTradePrompt(primary.name) });
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
    // decide() re-dispatches on this same tick. For the primary ship, also
    // clear the primary:trade cooldown so the local slot refills immediately.
    const events = parseAssistantEvents(snapshot);
    for (const ev of events) {
      appendLog({ type: 'event', ...ev });
      for (const prefix of ev.clearsCooldownFor || []) {
        state.lastDecisionAt.delete(`${prefix}:${ev.ship}`);
      }
      if (ev.isPrimary) {
        state.lastDecisionAt.delete('primary:trade');
      }
    }

    const decisions = decide(snapshot);

    const corpActiveCount = (snapshot?.extracted?.ships || []).filter((s) => !s.primary && s.active === true).length;
    const cappedNow = corpActiveCount >= state.config.corpTaskCap;
    appendLog({
      type: 'tick',
      snapshot: snapshot?.extracted ? {
        ships: (snapshot.extracted.ships || []).map((s) => ({
          name: s.name, warp: s.warpPower, sector: s.sector, active: s.active, primary: s.primary
        })),
        creditsBank: snapshot.extracted.creditsBank,
        creditsOnHand: snapshot.extracted.creditsOnHand,
        anyTaskWorking: snapshot.extracted.anyTaskWorking,
        tasksRunning: (snapshot.extracted.tasks || []).filter((t) => t.working).length,
        corpActive: corpActiveCount,
        corpTaskCap: state.config.corpTaskCap,
        capped: cappedNow
      } : null,
      decisionCount: decisions.length,
      capped: cappedNow
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
