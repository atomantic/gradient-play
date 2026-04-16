import { getGameSnapshot, sendAssistantPrompt, clickGameReconnect, loginIfNeeded } from './cdp.js';
import { observe as intelObserve, dangerousSectors } from './intel.js';
import { buildRefuelPlan, buildFleetRallyPlan, FLEET_PLAN_KEY, currentStepOf, isComplete, advance } from './plans.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Known mega-port sectors — strategic hubs within federation space.
// Discovered so far; more may exist. Configurable via cfg.megaports.
const DEFAULT_MEGAPORTS = [305, 472, 1413];
const megaportList = () => (state.config?.megaports || DEFAULT_MEGAPORTS).join('/');
const megaportSectors = () => state.config?.megaports || DEFAULT_MEGAPORTS;
const homeHub = () => state.config?.homeHub ?? DEFAULTS.homeHub;


/**
 * Standing policy clause appended to dispatch prompts so the agent knows how
 * to handle a garrison toll without a round-trip. Default: pay small tolls,
 * route around large ones. "Flee" is explicitly off the table because fleeing
 * a toll triggers combat damage.
 */
/**
 * Compact standing-orders suffix. All policy in one short bracket so the game
 * chat input doesn't truncate the core task instruction.
 */
const standingOrders = (shipName = '', { isProbe = false, creditKeep = 1000 } = {}) => {
  const cfg = state.config || {};
  const bad = dangerousSectors();
  const parts = [];
  if (cfg.safeMode && !isProbe) parts.push('fedspace');
  if (bad.length) parts.push(`avoid ${bad.slice(0, 6).join(',')}`);
  parts.push('avoid tolls');
  if (isProbe) parts.push('bank all credits');
  else if (creditKeep > 0) parts.push(`bank >${creditKeep}`);
  parts.push('execute now');
  return ` [${parts.join('; ')}]`;
};

const interactiveOnlyClause = () => ' [no new task — interactive only]';

const refuelPrompt = (ship, warp) => pick([
  `refuel ${ship} at hub ${homeHub()} (${warp} warp)`,
  `${ship}: ${warp} warp, head to hub ${homeHub()} to refuel`,
  `recall ${ship} to hub ${homeHub()} for refuel (${warp} warp)`
]) + standingOrders(ship);

/**
 * Stranded / near-stranded ship: warp too low to reliably reach a megaport.
 * Ask the agent to transfer_warp_power from a nearby corpmate before the
 * ship drains to 0 and is stuck for good. Short cooldown — this is urgent.
 */
const rescueStrandedPrompt = (ship, sector, warp) => {
  const loc = sector != null ? ` @${sector}` : '';
  return pick([
    `rescue ${ship}${loc} (${warp} warp): transfer_warp_power from nearest corpmate, then to hub ${homeHub()}`,
    `${ship} stranded${loc}, ${warp} warp — transfer_warp_power from fueled corpmate, route to hub`,
    `${ship} dry${loc} (${warp} warp): corpmate rescue via transfer_warp_power, megaport`
  ]) + standingOrders(ship) + interactiveOnlyClause();
};

const probeExplorePrompt = (probe, hops) => pick([
  `${probe}: explore ${hops} hops from hub ${homeHub()}, frontier edges, claim salvage, return to refuel`,
  `${probe}: map ${hops} hops outward, grab salvage, return to hub ${homeHub()} before warp runs low`,
  `${probe}: explore frontier ${hops} hops, salvage, refuel at hub ${homeHub()}`
]) + standingOrders(probe, { isProbe: true });

const haulerTradePrompt = (hauler) => pick([
  `${hauler}: NS trade loop, fedspace, 2-3 hops, rotate routes if stock depletes`,
  `put ${hauler} on NS trade, 2-3 hop fedspace loop, rotate on depletion`,
  `${hauler}: 2-3 hop NS loop in fedspace, rotate routes as needed`
]) + standingOrders(hauler);

const bankSweepPrompt = (excess, onHand, floor) => pick([
  `bank ${excess} credits next dock, keep ${floor}` + interactiveOnlyClause(),
  `sweep ${excess} to bank, hold ${floor}` + interactiveOnlyClause(),
  `deposit ${excess}, keep ${floor}` + interactiveOnlyClause()
]);

/**
 * Per-corp-ship credit sweep. Corp ships don't have direct bank_deposit on
 * every mechanic set, so we give the agent the option: deposit if docked, or
 * transfer_credits to our primary ship to bank.
 */
/**
 * Seed an idle corp ship with operational credits before dispatch. Ships
 * leaving the hub without enough credits can't afford to refuel at other
 * ports or make opening trades.
 */
const shipFundPrompt = (ship, credits, needed) => pick([
  `${ship} has only ${credits} credits — transfer ${needed} from primary (or bank_withdraw) before dispatch` + interactiveOnlyClause(),
  `seed ${ship} with ${needed} credits from primary before it leaves hub (currently ${credits})` + interactiveOnlyClause(),
  `${ship}: ${credits} credits, needs ${needed} for operations. transfer from primary, then dispatch` + interactiveOnlyClause()
]);

const shipSweepPrompt = (ship, credits, excess, keep) => pick([
  `${ship}: ${credits} credits — rendezvous with primary at hub ${homeHub()}, transfer ${excess}, primary banks it, keep ${keep}` + interactiveOnlyClause(),
  `sweep ${ship} (${credits}): meet primary at hub, transfer ${excess} to primary for banking, keep ${keep}` + interactiveOnlyClause(),
  `${ship}: ${credits} on hand — dock with primary at hub ${homeHub()}, transfer ${excess}, keep ${keep}` + interactiveOnlyClause()
]);

const upgradePrompt = (shipName, total, next) => pick([
  `upgrade ${shipName} → ${next.name} (${next.price}) at hub ${homeHub()}` + interactiveOnlyClause(),
  `${total} credits — trade ${shipName} for ${next.name} at next dock` + interactiveOnlyClause(),
  `swap ${shipName} → ${next.name} next megaport` + interactiveOnlyClause()
]);

const primaryTradePrompt = (primary) => pick([
  `${primary}: NS trade loop, fedspace, 2-3 hops, rotate on depletion`,
  `${primary}: fedspace NS trade, 2-3 hops, switch routes if stock thins`,
  `${primary}: NS 2-3 hop loop, fedspace, rotate routes as needed`
]) + standingOrders(primary);

/**
 * Reckless frontier mode for the primary ship. Leaves fedspace, hunts
 * salvage, engages combat, trades only for fuel money. Comes home to the
 * megaport hub when warp gets low. Safe-mode is explicitly bypassed.
 */
const primaryTroubleMakerPrompt = (primary) => {
  const bad = dangerousSectors();
  const parts = [];
  if (bad.length) parts.push(`avoid ${bad.slice(0, 6).join(',')}`);
  parts.push('avoid tolls');
  parts.push('execute now');
  const orders = ` [${parts.join('; ')}]`;
  return pick([
    `${primary}: troublemaker run. bank_deposit down to 1000 on-hand first, then push beyond fedspace. hunt salvage, engage combat when profitable, trade only for fuel money. return to hub ${homeHub()} to recharge_warp_power when warp runs low.`,
    `${primary}: frontier salvage hunt. first deposit excess to bank (keep 1000), then exit fedspace, claim salvage, combat OK, trade as needed to stay fueled. hub ${homeHub()} for refuel cycles.`,
    `${primary}: reckless explorer. deposit bank down to 1000 on-hand, venture into the unknown beyond fedspace, grab salvage, fight for it, trade minimally for fuel. refuel at hub ${homeHub()} between runs.`
  ]) + orders;
};

const DEFAULTS = {
  pollIntervalSec: 60,
  minWarp: 50,                    // below this: normal refuel (ship can still reach a megaport)
  dispatchMinWarp: 200,           // idle ships below this get refueled instead of dispatched — prevents stranding
  fuelCriticalWarp: 15,           // below this: emergency — request transfer_warp_power rescue
  refuelCooldownSec: 180,         // per-ship: re-nag every 3 min if warp stays low
  rescueCooldownSec: 90,          // per-ship: re-nag every 90s if stranded
  creditsForRefuel: 1000,         // credits to transfer to a corp ship before recharge if it's broke
  shipFundingFloor: 1000,         // minimum credits a ship should have before dispatch — seed from primary if below
  onHandFloor: 1000,              // working float to keep on-hand on every ship
  depositExcessOver: 4000,        // trigger sweep when on-hand is floor+this (so 5000 → deposit 4000, leave 1000)
  decisionCooldownSec: 420,       // 7 min — longer than a typical refuel or task handoff
  exploreMaxHops: 40,
  considerUpgrades: true,
  upgradeCreditsThreshold: 100000,
  corpTaskCap: 3,                 // fallback if DOM taskSlots.total isn't reported
  probeSlots: 2,                   // how many probes to keep exploring at once
  tradeSlots: 2,                   // how many haulers/traders to keep running at once
  primaryDispatchCooldownSec: 300,  // 5 min — tight enough to refill the local slot quickly when a task ends
  megaports: [305, 472, 1413],      // known mega-port sectors — add more as probes discover them
  homeHub: 1413,                    // preferred dock for fuel/banking — the fleet's home base
  safeMode: true,                  // restrict non-probe ships to federation space
  isCeo: false,                    // only CEO can manage corp ships; non-CEO autopilot only drives the primary
  troubleMaker: false,             // reckless mode: primary leaves fedspace for salvage + combat + frontier trading
  maxDecisionsPerTick: 2,          // never fire more than N prompts in one tick — avoids flooding the agent
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
  subscribers: new Set(),
  plans: new Map(), // ship name → active plan (one at a time per ship)
  prevWarp: new Map() // ship name → last-tick warp, used to detect in-flight ships
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
  if (/PROBE|EXPLORER|SCAVENGER|SALVAGER|SCOUT|PATHFINDER/.test(n)) return 'probe';
  if (/HAULER|FREIGHTER|LIFTER|ATLAS|PIONEER|WAYFARER|WAREZ|TRADER/.test(n)) return 'hauler';
  if (/KESTREL|SPARROW|COURIER/.test(n)) return 'trader-light';
  if (/CORSAIR|PIKE|BULWARK|AEGIS|SOVEREIGN|RAIDER|FRIGATE|DESTROYER|CRUISER/.test(n)) return 'combat';
  if (/REFUELER|TANKER|FUEL/.test(n)) return 'probe';
  return 'unknown';
};

/**
 * Inspect ship name for role hints. The user renames probes to encode
 * intent ("refueler", "explorer", "scavenger"). decide() dispatches
 * role-specific prompts when a role is found; otherwise falls back to the
 * generic probeExplorePrompt.
 */
const probeRole = (name = '') => {
  const n = name.toUpperCase();
  if (/REFUELER|TANKER|FUEL[- ]?SHIP/.test(n)) return 'refueler';
  if (/EXPLORER|SCOUT|PATHFINDER/.test(n)) return 'explorer';
  if (/SCAVENGER|SALVAGER/.test(n)) return 'scavenger';
  return null;
};

const refuelerDispatchPrompt = (refueler, target, targetSector, targetWarp) => {
  const loc = targetSector != null ? ` @${targetSector}` : '';
  return pick([
    `${refueler}: rescue ${target}${loc} (${targetWarp} warp), transfer_warp_power, return to hub ${homeHub()}`,
    `fuel drop: ${refueler} → ${target}${loc}, transfer warp, back to hub`,
    `${refueler}: route to ${target}${loc}, transfer_warp_power, return to hub ${homeHub()}`
  ]) + standingOrders(refueler, { isProbe: true });
};

const refuelerStandbyPrompt = (refueler) => pick([
  `${refueler}: standby at hub ${homeHub()}, full warp, no trade/explore`,
  `park ${refueler} at hub ${homeHub()}, fully fueled, on-call`,
  `${refueler} standby: hub ${homeHub()}, full warp, wait`
]) + standingOrders(refueler, { isProbe: true });

const scavengerPrompt = (scav, hops) => pick([
  `${scav}: salvage run ${hops} hops from hub ${homeHub()}, frontier edges, return to refuel`,
  `${scav}: ${hops} hop salvage sweep, frontier, return to hub ${homeHub()} before warp runs low`,
  `${scav}: ${hops} hops outward, claim salvage, back to hub to refuel`
]) + standingOrders(scav, { isProbe: true });

const explorerPrompt = (expl, hops) => pick([
  `${expl}: explore ${hops} hops from hub ${homeHub()}, frontier edges, claim salvage, return to refuel`,
  `${expl}: map ${hops} hops outward, frontier sectors, back to hub ${homeHub()} before warp runs low`,
  `${expl}: ${hops} hops along frontier, salvage, return to hub to refuel`
]) + standingOrders(expl, { isProbe: true });

// Next upgrade tier by current ship class, from strategy.md.
// netCost = price minus ~60% trade-in value of the current ship. This is
// what you actually need in cash to upgrade (the old ship covers the rest).
const NEXT_UPGRADE = {
  SPARROW: { name: 'Kestrel Courier', price: 25000, netCost: 10000 },
  KESTREL: { name: 'Wayfarer Freighter', price: 120000, netCost: 105000 },
  WAYFARER: { name: 'Pioneer Lifter', price: 220000, netCost: 148000 },
  PIONEER: { name: 'Atlas Hauler', price: 260000, netCost: 128000 },
  ATLAS: { name: 'Sovereign Starcruiser', price: 2500000, netCost: 2344000 },
  CORSAIR: { name: 'Pike Frigate', price: 300000, netCost: 192000 },
  PIKE: { name: 'Bulwark Destroyer', price: 450000, netCost: 270000 },
  BULWARK: { name: 'Aegis Cruiser', price: 700000, netCost: 430000 },
  AEGIS: { name: 'Sovereign Starcruiser', price: 2500000, netCost: 2080000 }
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
 * A decision may instead carry `createPlan: <Plan>`, which the caller stores
 * in state.plans and fires the first step of. Ships with an active plan are
 * skipped here — their plan owns their dispatch until it completes.
 *
 * Caller applies cooldown dedup and sends prompts.
 */
const decide = (snapshot) => {
  const cfg = state.config;
  const ex = snapshot?.extracted || {};
  const ships = ex.ships || [];
  const out = [];
  const cooldownMs = cfg.decisionCooldownSec * 1000;
  const hasPlan = (name) => state.plans.has(name);
  // CEO mode: only when the user is the corporation's CEO should autopilot
  // manage corp ships. Task slots are shared across all corp members — if two
  // CEOs (or a non-CEO) fire dispatches, they trample each other. Default
  // off; flip on from the UI.
  const ceo = !!cfg.isCeo;

  // When a fleet-wide rally plan is running, it owns every ship — skip all
  // per-ship decisions so we don't interfere with the coordinated operation.
  if (state.plans.has(FLEET_PLAN_KEY)) return out;

  // Task-slot budget. Every autonomous task (trade, explore, refuel sequence,
  // rescue run…) consumes one of the 4 shared slots. Prefer the DOM's own
  // "N/M SLOTS USED" counter — it's authoritative and covers the player's
  // local task slot too. Fall back to activeCorp when that scrape is absent.
  const domUsed = ex.taskSlots?.used;
  const domTotalSlots = ex.taskSlots?.total;
  let slotBudget;
  if (domUsed != null && domTotalSlots != null) {
    slotBudget = Math.max(0, domTotalSlots - domUsed);
  } else {
    const activeNow = ships.filter((s) => s.active === true).length;
    slotBudget = Math.max(0, (cfg.corpTaskCap + 1) - activeNow);
  }
  // Plans currently under way also occupy a slot for their lifetime (each plan
  // has the agent running some kind of task on its ship).
  const pushTaskDecision = (d) => {
    if (slotBudget <= 0) return false;
    slotBudget -= 1;
    out.push({ ...d, createsTask: true });
    return true;
  };
  const pushInteractive = (d) => out.push({ ...d, createsTask: false });

  // Fuel guard runs first for every ship (including active ones — a break-off
  // order to recharge supersedes any running task).
  //
  // Two tiers:
  //   - warp < fuelCriticalWarp → STRANDED. Ship probably can't reach a megaport
  //     under its own power. Emit rescueStrandedPrompt so the agent uses
  //     transfer_warp_power from a nearby corpmate. Short cooldown (90s) so we
  //     keep nagging until the rescue happens.
  //   - warp < minWarp → LOW. Standard refuel prompt: break off, route to megaport.
  //     Medium cooldown (180s) — tighter than the general decisionCooldown so we
  //     don't let a ship drain from 50 to 0 across a single 7-min cooldown window.
  // Identify a dedicated refueler probe (name-based). If present, stranded
  // ships get a targeted refueler dispatch instead of the generic rescue prompt.
  const refueler = ships.find((s) => probeRole(s.name) === 'refueler' && !s.primary);
  const refuelerAvailable = refueler && refueler.active === false
    && refueler.warpPower != null
    && refueler.warpPower >= Math.max(cfg.minWarp, 100);

  for (const s of ships) {
    if (!cfg.enabled.refuel) continue;
    if (s.warpPower == null) continue;
    if (hasPlan(s.name)) continue; // plan owns this ship's next action
    if (!ceo && !s.primary) continue; // non-CEO: don't touch corp ships
    if (s.warpPower < cfg.fuelCriticalWarp) {
      // Stranded. transfer_warp_power is a single interactive call — doesn't
      // need a task slot. Refueler dispatch *is* a multi-step trip (route →
      // transfer → return) so it takes a slot.
      const targetIsRefueler = refueler && s.name === refueler.name;
      if (refuelerAvailable && !targetIsRefueler) {
        const key = `refueler-dispatch:${s.name}`;
        if (canAct(key, cfg.rescueCooldownSec * 1000)) {
          pushTaskDecision({ key, ship: refueler.name, text: refuelerDispatchPrompt(refueler.name, s.name, s.sector, s.warpPower) });
        }
      } else {
        const key = `rescue:${s.name}`;
        if (canAct(key, cfg.rescueCooldownSec * 1000)) {
          pushInteractive({ key, ship: s.name, text: rescueStrandedPrompt(s.name, s.sector, s.warpPower) });
        }
      }
    } else {
      // Two-tier fuel threshold:
      //   - Active ships: only interrupt for refuel when warp < minWarp (50)
      //     — a running task is valuable, don't break it unless critical.
      //   - Idle ships: refuel anything below dispatchMinWarp (200) before giving
      //     it a new task. Idle probes at 150 warp can't meaningfully explore
      //     40 hops and return — they'd get stranded far from home.
      // ALSO: if a ship's warp dropped since last tick, it's actively moving
      // (likely already heading to refuel via direct prompt or plan) — skip.
      const isActiveTask = s.active === true;
      const threshold = isActiveTask ? cfg.minWarp : (cfg.dispatchMinWarp ?? cfg.minWarp);
      const prevWarp = state.prevWarp.get(s.name);
      const isMoving = prevWarp != null && s.warpPower < prevWarp;
      if (s.warpPower < threshold && !isMoving) {
        if (slotBudget > 0) {
          const plan = buildRefuelPlan(s, { creditsForRefuel: cfg.creditsForRefuel });
          slotBudget -= 1;
          out.push({ key: `plan-create:refuel:${s.name}`, ship: s.name, createPlan: plan, createsTask: true });
        }
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
  //
  // Non-CEO: skip all corp-ship dispatch. Task slots are shared across the
  // corporation; only the CEO should be allocating them.
  const skipCorpWork = !ceo;
  const corpShips = ships.filter((s) => !s.primary);
  const activeCorp = corpShips.filter((s) => s.active === true);
  // Idle ships must have enough warp to meaningfully execute a new task AND
  // return home safely. dispatchMinWarp guards against stranding.
  const idleCorp = corpShips.filter((s) => s.active === false && s.warpPower != null && s.warpPower >= (cfg.dispatchMinWarp ?? cfg.minWarp));

  const activeProbeCount = activeCorp.filter((s) => shipKind(s.name) === 'probe').length;
  // Refuelers are managed by the rescue flow above — don't dispatch them on explore/salvage.
  const idleProbes = idleCorp.filter((s) => shipKind(s.name) === 'probe' && probeRole(s.name) !== 'refueler');
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

  // Balanced fleet allocation: cfg.probeSlots probes exploring + cfg.tradeSlots
  // haulers trading. Probes and haulers each get their own quota so one type
  // doesn't starve the other of task slots.
  //
  // Probe dispatch: fill up to probeSlots. When no rescue is pending, the
  // refueler is also eligible for exploration (the user repurposes it to
  // explore when no ship needs fuel).
  const probeTarget = cfg.probeSlots ?? 2;
  const allIdleProbes = idleCorp.filter((s) => shipKind(s.name) === 'probe');
  allIdleProbes.sort((a, b) => (b.warpPower || 0) - (a.warpPower || 0));
  const needsRescue = out.some((d) => d.key?.startsWith('rescue:') || d.key?.startsWith('refueler-dispatch:'));
  let probesSent = activeProbeCount;

  // Credit-seeding guard: if an idle corp ship is at the home hub with less
  // than shipFundingFloor credits, fund it before dispatch. Skip dispatch this
  // tick — next tick the ship will have credits and can be dispatched then.
  const fundingFloor = cfg.shipFundingFloor ?? cfg.creditsForRefuel ?? 1000;
  const needsFunding = (s) =>
    s.credits != null &&
    s.credits < fundingFloor &&
    s.sector === homeHub() &&
    !hasPlan(s.name);

  for (const probe of allIdleProbes) {
    if (skipCorpWork) break;
    if (probesSent >= probeTarget) break;
    if (remainingSlots <= 0) break;
    if (!cfg.enabled.explore) break;
    if (hasPlan(probe.name)) continue;
    if (probeRole(probe.name) === 'refueler' && needsRescue) continue;
    // Fund first if at hub and broke — probes don't generally carry credits
    // but may need some for recharge_warp_power on return trips.
    if (needsFunding(probe)) {
      const key = `fund:${probe.name}`;
      if (canAct(key, cfg.refuelCooldownSec * 1000)) {
        pushInteractive({ key, ship: probe.name, text: shipFundPrompt(probe.name, probe.credits, fundingFloor) });
      }
      continue; // skip dispatch this tick
    }
    const role = probeRole(probe.name);
    const key = `${role || 'explore'}:${probe.name}`;
    if (!canAct(key, cooldownMs)) continue;
    let text;
    if (role === 'explorer') text = explorerPrompt(probe.name, cfg.exploreMaxHops);
    else if (role === 'scavenger') text = scavengerPrompt(probe.name, cfg.exploreMaxHops);
    else if (role === 'refueler') text = probeExplorePrompt(probe.name, cfg.exploreMaxHops);
    else text = probeExplorePrompt(probe.name, cfg.exploreMaxHops);
    if (pushTaskDecision({ key, ship: probe.name, text })) {
      remainingSlots -= 1;
      probesSent += 1;
    }
  }

  // Fill up to tradeSlots with haulers on safe trade loops.
  const tradeTarget = cfg.tradeSlots ?? 2;
  const activeTradeCount = activeCorp.filter((s) => ['hauler', 'trader-light'].includes(shipKind(s.name))).length;
  let tradesSent = activeTradeCount;

  for (const hauler of idleHaulers) {
    if (skipCorpWork) break;
    if (tradesSent >= tradeTarget) break;
    if (remainingSlots <= 0) break;
    if (!cfg.enabled.trade) break;
    if (hasPlan(hauler.name)) continue;
    // Fund first if broke at hub — haulers especially need trading capital.
    if (needsFunding(hauler)) {
      const key = `fund:${hauler.name}`;
      if (canAct(key, cfg.refuelCooldownSec * 1000)) {
        pushInteractive({ key, ship: hauler.name, text: shipFundPrompt(hauler.name, hauler.credits, fundingFloor) });
      }
      continue; // skip dispatch this tick
    }
    const key = `trade:${hauler.name}`;
    if (!canAct(key, cooldownMs)) continue;
    if (pushTaskDecision({ key, ship: hauler.name, text: haulerTradePrompt(hauler.name) })) {
      remainingSlots -= 1;
      tradesSent += 1;
    }
  }

  // Bank excess credits aggressively for EVERY ship, not just the player's on-hand.
  // Destruction drops whatever the ship is carrying; bank balance is untouchable.
  // Policy: when a ship reaches (onHandFloor + depositExcessOver) credits,
  // sweep down to onHandFloor at the next megaport.
  if (cfg.enabled.bank) {
    // Player on-hand (comes from the top-bar, not the per-ship credits field).
    const onHand = ex.creditsOnHand ?? 0;
    const excess = onHand - cfg.onHandFloor;
    if (excess >= cfg.depositExcessOver) {
      const key = 'bank:sweep';
      if (canAct(key, cooldownMs)) {
        pushInteractive({ key, text: bankSweepPrompt(excess, onHand, cfg.onHandFloor) });
      }
    }

    // Per-corp-ship sweep: each ship gets its own cooldown so we can nag any
    // cash-heavy ship independently of the others. Only when CEO.
    for (const s of ships) {
      if (skipCorpWork) break;
      if (s.primary) continue; // primary is handled by the player on-hand branch above
      if (s.credits == null) continue;
      if (hasPlan(s.name)) continue;
      const shipExcess = s.credits - cfg.onHandFloor;
      if (shipExcess < cfg.depositExcessOver) continue;
      const key = `bank:ship:${s.name}`;
      if (!canAct(key, cooldownMs)) continue;
      pushInteractive({
        key,
        ship: s.name,
        text: shipSweepPrompt(s.name, s.credits, shipExcess, cfg.onHandFloor)
      });
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
    if (next && total >= (next.netCost ?? next.price)) {
      const key = `upgrade:${next.name}`;
      if (canAct(key, cooldownMs * 2)) {
        // Ship swap happens at a dock in one sitting — interactive, not a task.
        pushInteractive({ key, text: upgradePrompt(ex.shipName, total, next) });
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
      primary.warpPower >= cfg.minWarp &&
      !hasPlan(primary.name)
    ) {
      const key = cfg.troubleMaker ? 'primary:troublemaker' : 'primary:trade';
      if (canAct(key, cfg.primaryDispatchCooldownSec * 1000)) {
        const text = cfg.troubleMaker
          ? primaryTroubleMakerPrompt(primary.name)
          : primaryTradePrompt(primary.name);
        pushTaskDecision({ key, ship: primary.name, text });
      }
    }
  }

  return out;
};

/**
 * Walk each active plan against the latest snapshot. Advance steps whose
 * isDone() returns true (or whose maxMs has elapsed), fire the newly-active
 * step's prompt, and drop completed plans. Stalled steps get re-prompted on
 * each step's nagMs cadence.
 */
const processPlans = async (snapshot) => {
  const ships = snapshot?.extracted?.ships || [];
  const doneShips = [];

  for (const [shipName, plan] of state.plans) {
    // Fleet plans use a sentinel key; isDone gets the full snapshot, not a ship.
    const isFleet = shipName === FLEET_PLAN_KEY;
    const ship = isFleet ? null : ships.find((s) => s.name === shipName);
    if (!isFleet && !ship) continue; // ship not in snapshot yet; wait a tick
    const step = currentStepOf(plan);
    if (!step) { doneShips.push(shipName); continue; }

    const done = !!step.isDone?.(snapshot, ship, plan);
    const stepAge = Date.now() - plan.stepStartedAt;
    const timedOut = step.maxMs != null && stepAge > step.maxMs;

    if (done || timedOut) {
      advance(plan, done ? 'done' : 'timeout');
      appendLog({
        type: 'plan',
        shipName,
        goal: plan.goal,
        event: 'advance',
        fromStep: step.name,
        reason: done ? 'done' : 'timeout',
        stepAgeMs: stepAge
      });
      if (isComplete(plan)) {
        appendLog({ type: 'plan', shipName, goal: plan.goal, event: 'complete' });
        doneShips.push(shipName);
        continue;
      }
      const next = currentStepOf(plan);
      const send = await sendAssistantPrompt(next.prompt).catch((e) => ({ ok: false, error: e.message }));
      plan.lastPromptedAt = Date.now();
      plan.promptCount += 1;
      appendLog({ type: 'plan', shipName, goal: plan.goal, event: 'prompt', step: next.name, text: next.prompt, send });
    } else {
      // Nag: step still running — re-send the prompt if it's been a while.
      const sinceLast = Date.now() - (plan.lastPromptedAt || plan.stepStartedAt);
      const nagMs = step.nagMs ?? 120_000;
      if (sinceLast > nagMs) {
        const send = await sendAssistantPrompt(step.prompt).catch((e) => ({ ok: false, error: e.message }));
        plan.lastPromptedAt = Date.now();
        plan.promptCount += 1;
        appendLog({ type: 'plan', shipName, goal: plan.goal, event: 'nag', step: step.name, text: step.prompt, send });
      }
    }
  }

  for (const s of doneShips) state.plans.delete(s);
};

const runTick = async () => {
  if (!state.running) return;
  try {
    const snapshot = await getGameSnapshot();
    state.lastSnapshot = snapshot;
    if (snapshot && snapshot.connected === false) {
      appendLog({ type: 'error', error: `cdp disconnected${snapshot.error ? ': ' + snapshot.error : ''} — will retry next tick` });
      return;
    }
    if (snapshot?.extracted?.gameDisconnected) {
      const click = await clickGameReconnect().catch((e) => ({ ok: false, error: e.message }));
      // Give the game a beat to tear down the modal and render whatever comes next
      // (fresh HUD if the session survived, or a login form if it didn't), then
      // run loginIfNeeded — it's a no-op when we're already authed, and a full
      // login + character-select flow otherwise.
      await new Promise((r) => setTimeout(r, 1500));
      const login = await loginIfNeeded().catch((e) => ({ ok: false, error: e.message }));
      appendLog({
        type: 'event',
        intelType: 'game-disconnect',
        snippet: 'game "DISCONNECTED" modal — clicked RECONNECT, then loginIfNeeded',
        click,
        login
      });
      return;
    }

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

    // Auto-confirm: the agent occasionally stalls with an explicit confirmation
    // request instead of just executing ("Ready to transfer… on your order").
    // Only fire on VERY explicit ask-for-approval patterns — status updates
    // like "Fleet operations are ongoing" must NOT trigger. Word boundaries
    // keep "ready to" from matching "already to" etc.
    const msgs = snapshot?.extracted?.lastMessages || [];
    const lastAssistantMsg = [...msgs].reverse().find((m) => m && /ASSISTANT[:\s]/i.test(m));
    if (lastAssistantMsg) {
      const endsWithQuestion = /\?\s*$/.test(lastAssistantMsg);
      const explicitAsk = [
        /\bshall i (proceed|continue|begin|execute|transfer|withdraw|deposit|send|dispatch|fire)\b/i,
        /\bshould i (proceed|continue|begin|execute|transfer|withdraw|deposit|send|dispatch|fire)\b/i,
        /\bwould you like me to\b/i,
        /\bdo you want me to\b/i,
        /\b(awaiting|await) (your )?(order|confirmation|approval|command|go-ahead)\b/i,
        /\bon your order,?\s*(commander)?\b/i,
        /\blet me know (if|when) (you|to)\b/i,
        /\bplease (confirm|advise|approve)\b/i
      ].some((re) => re.test(lastAssistantMsg));
      const isAskingForApproval = endsWithQuestion || explicitAsk;
      const lastUserMsg = [...msgs].reverse().find((m) => m && /USER[:\s]/i.test(m));
      const userAlreadyReplied = lastUserMsg && msgs.indexOf(lastUserMsg) > msgs.indexOf(lastAssistantMsg);
      if (isAskingForApproval && !userAlreadyReplied) {
        const key = `auto-confirm:${lastAssistantMsg.slice(0, 60)}`;
        if (!state.seenEventKeys.has(key)) {
          state.seenEventKeys.add(key);
          await sendAssistantPrompt('yes, proceed').catch(() => {});
          appendLog({ type: 'event', intelType: 'auto-confirm', snippet: lastAssistantMsg.slice(0, 120) });
        }
      }
    }

    // Process any active multi-step plans first — they own their ships' next
    // actions and suppress one-shot decide() dispatches for the same ship.
    await processPlans(snapshot);

    const decisions = decide(snapshot);

    // Record current warp per ship so next tick can detect in-flight movement.
    for (const s of (snapshot?.extracted?.ships || [])) {
      if (s.name && s.warpPower != null) state.prevWarp.set(s.name, s.warpPower);
    }

    const corpActiveCount = (snapshot?.extracted?.ships || []).filter((s) => !s.primary && s.active === true).length;
    const cappedNow = corpActiveCount >= state.config.corpTaskCap;
    const slotsUsed = snapshot?.extracted?.taskSlots?.used;
    const slotsTotal = snapshot?.extracted?.taskSlots?.total;
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
        taskSlots: slotsUsed != null && slotsTotal != null ? `${slotsUsed}/${slotsTotal}` : null,
        capped: cappedNow
      } : null,
      decisionCount: decisions.length,
      capped: cappedNow
    });

    // Guards: one action per ship per tick, and a global cap to avoid
    // flooding the agent's input with back-to-back prompts.
    const maxPerTick = state.config.maxDecisionsPerTick ?? 2;
    const shipsPrompted = new Set();
    let promptsSent = 0;

    for (const d of decisions) {
      if (promptsSent >= maxPerTick) {
        appendLog({ type: 'decision', key: d.key, ship: d.ship, text: '(deferred — hit per-tick cap)', skipped: true });
        continue;
      }
      if (d.ship && shipsPrompted.has(d.ship)) {
        appendLog({ type: 'decision', key: d.key, ship: d.ship, text: '(deferred — ship already prompted this tick)', skipped: true });
        continue;
      }

      if (d.createPlan) {
        const plan = d.createPlan;
        const planShip = (snapshot?.extracted?.ships || []).find((s) => s.name === d.ship);
        // Pre-advance through steps whose isDone is already satisfied — e.g.
        // creating a refuel plan when the ship is already docked at a megaport,
        // we skip step 1 (route) and fire step 2 (fund or recharge) instead.
        while (!isComplete(plan)) {
          const step = currentStepOf(plan);
          if (!step?.isDone?.(snapshot, planShip, plan)) break;
          advance(plan, 'pre-satisfied');
        }
        state.plans.set(d.ship, plan);
        state.lastDecisionAt.set(d.key, Date.now());
        if (isComplete(plan)) {
          appendLog({ type: 'plan', shipName: d.ship, goal: plan.goal, event: 'complete', note: 'all steps pre-satisfied' });
          state.plans.delete(d.ship);
        } else {
          const first = currentStepOf(plan);
          const send = await sendAssistantPrompt(first.prompt).catch((e) => ({ ok: false, error: e.message }));
          plan.lastPromptedAt = Date.now();
          plan.promptCount += 1;
          appendLog({
            type: 'plan',
            shipName: d.ship,
            goal: plan.goal,
            event: 'create',
            stepCount: plan.steps.length,
            step: first.name,
            text: first.prompt,
            send
          });
        }
      } else {
        const send = await sendAssistantPrompt(d.text).catch((e) => ({ ok: false, error: e.message }));
        state.lastDecisionAt.set(d.key, Date.now());
        appendLog({ type: 'decision', key: d.key, ship: d.ship, text: d.text, send });
      }
      if (d.ship) shipsPrompted.add(d.ship);
      promptsSent += 1;
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
  // Guard: homeHub must be one of the known megaports. A stale localStorage
  // value (or typo in the UI) could otherwise send the fleet to an invalid
  // sector. Fall back to the first megaport if the configured hub isn't in
  // the list.
  const mps = state.config.megaports || DEFAULT_MEGAPORTS;
  let homeHubFallbackNote = null;
  if (!mps.includes(state.config.homeHub)) {
    const fallback = mps.includes(DEFAULTS.homeHub) ? DEFAULTS.homeHub : mps[0];
    homeHubFallbackNote = `homeHub ${state.config.homeHub} not in megaports ${mps.join('/')} — falling back to ${fallback}`;
    state.config.homeHub = fallback;
  }
  state.running = true;
  state.startedAt = Date.now();
  state.lastDecisionAt.clear();
  state.seenEventKeys.clear();
  state.plans.clear();
  state.log.length = 0;
  if (homeHubFallbackNote) appendLog({ type: 'error', error: homeHubFallbackNote });
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
  lastDecisions: Object.fromEntries(state.lastDecisionAt),
  plans: Array.from(state.plans.values()).map((p) => ({
    id: p.id,
    ship: p.ship,
    goal: p.goal,
    currentStep: p.currentStep,
    steps: p.steps.map((s) => ({ name: s.name })),
    stepStartedAt: p.stepStartedAt,
    promptCount: p.promptCount,
    history: p.history
  }))
});

const buildLiveRallyPlan = async ({ resume }) => {
  let snap = state.lastSnapshot;
  let ships = snap?.extracted?.ships || [];
  if (ships.length === 0) {
    snap = await getGameSnapshot();
    state.lastSnapshot = snap;
    ships = snap?.extracted?.ships || [];
  }
  if (ships.length === 0) return { error: 'no ships in snapshot — is CDP connected?' };
  const plan = buildFleetRallyPlan(ships, {
    keepCredits: state.config?.onHandFloor ?? 1000,
    megaports: megaportSectors(),
    homeHub: homeHub(),
    resume
  });
  return { plan, ships };
};

export const startFleetRally = async (opts = {}) => {
  if (state.plans.has(FLEET_PLAN_KEY)) {
    return { ok: false, error: 'fleet rally already in progress' };
  }
  // The plan machinery only advances when the autopilot tick is running.
  if (!state.running) startAutopilot({});
  const resume = opts.resume !== false;
  const { plan, ships, error } = await buildLiveRallyPlan({ resume });
  if (error) return { ok: false, error };
  plan.goal = resume ? 'rally-resume' : 'home-base';
  state.plans.set(FLEET_PLAN_KEY, plan);
  const first = currentStepOf(plan);
  const send = await sendAssistantPrompt(first.prompt).catch((e) => ({ ok: false, error: e.message }));
  plan.lastPromptedAt = Date.now();
  plan.promptCount = 1;
  appendLog({
    type: 'plan',
    shipName: FLEET_PLAN_KEY,
    goal: plan.goal,
    event: 'create',
    stepCount: plan.steps.length,
    step: first.name,
    text: first.prompt,
    send
  });
  return { ok: true, stepCount: plan.steps.length, shipCount: ships.length };
};

/**
 * Fire a single rally step as a one-shot prompt. No plan state, no nag, no
 * auto-advance — the user drives the sequence via the UI. Useful when ships
 * are already in position and the full rally would just spam the agent.
 *
 * Intentionally does NOT start autopilot. Autopilot's decide() loop fires
 * independent ship-fund/dispatch prompts that collide with the one-shot
 * rally step; running them together confuses the agent. The "execute
 * immediately, no confirmation needed" suffix on each step prompt should
 * keep the agent from asking for confirmation in the first place.
 */
export const fireRallyStep = async (stepName) => {
  if (stepName === 'fund-for-recharge') return queueFundSequence();
  if (stepName === 'credit-balance') return queueBalanceSequence();
  const { plan, ships, error } = await buildLiveRallyPlan({ resume: true });
  if (error) return { ok: false, error };
  const step = plan.steps.find((s) => s.name === stepName);
  if (!step) return { ok: false, error: `unknown step: ${stepName}` };
  const send = await sendAssistantPrompt(step.prompt).catch((e) => ({ ok: false, error: e.message }));
  appendLog({
    type: 'decision',
    key: `rally-step:${stepName}`,
    ship: FLEET_PLAN_KEY,
    text: step.prompt,
    send
  });
  return { ok: !!send.ok, step: stepName, shipCount: ships.length, send };
};

/**
 * Fire a sequence of one-action prompts in the background, spaced apart so
 * the agent can execute each before the next lands. Each prompt should be a
 * single directive (one bank_withdraw, one transfer_credits, one
 * bank_deposit, etc.) — the game executes these as distinct ship actions.
 */
const STEP_DELAY_MS = 12_000; // heuristic — time for the agent to complete one action
const queueRunning = {}; // key → bool

const drainQueue = (key, prompts) => {
  queueRunning[key] = true;
  (async () => {
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const send = await sendAssistantPrompt(p).catch((e) => ({ ok: false, error: e.message }));
      appendLog({
        type: 'decision',
        key,
        ship: FLEET_PLAN_KEY,
        text: `[${i + 1}/${prompts.length}] ${p}`,
        send
      });
      if (i < prompts.length - 1) await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
    }
    queueRunning[key] = false;
  })();
};

const freshSnapshot = async () => {
  let snap = state.lastSnapshot;
  if (!snap?.extracted) {
    snap = await getGameSnapshot();
    state.lastSnapshot = snap;
  }
  return snap;
};

/**
 * Fund each corp ship as a separate primary-ship action. One bank_withdraw
 * up front, then one transfer_credits per underfunded ship.
 */
export const queueFundSequence = async () => {
  if (queueRunning['fund-seq']) return { ok: false, error: 'fund sequence already running' };
  const snap = await freshSnapshot();
  const ships = snap?.extracted?.ships || [];
  if (ships.length === 0) return { ok: false, error: 'no ships in snapshot — is CDP connected?' };
  const primary = ships.find((s) => s.primary);
  const primaryName = primary?.name || 'the primary ship';
  const onHand = snap.extracted.creditsOnHand ?? 0;
  const keepFloor = state.config?.onHandFloor ?? 1000;

  const transfers = [];
  for (const s of ships) {
    if (s.primary) continue;
    if (s.credits != null && s.credits < 1000) transfers.push({ name: s.name, amount: 1000 - s.credits });
    else if (s.credits == null) transfers.push({ name: s.name, amount: 1000 });
  }
  if (transfers.length === 0) return { ok: true, queued: 0, note: 'no corp ships need funding' };

  const totalTransfer = transfers.reduce((sum, t) => sum + t.amount, 0);
  const withdrawNeeded = Math.max(0, totalTransfer + keepFloor - onHand);

  const prompts = [];
  if (withdrawNeeded > 0) {
    prompts.push(`${primaryName}: bank_withdraw ${withdrawNeeded} credits. one action, execute immediately, no confirmation.`);
  }
  for (const t of transfers) {
    prompts.push(`${primaryName}: transfer_credits ${t.amount} to ${t.name}. one action, execute immediately, no confirmation.`);
  }

  drainQueue('fund-seq', prompts);

  return {
    ok: true,
    step: 'fund-for-recharge',
    queued: prompts.length,
    totalTransfer,
    withdrawNeeded,
    transfers
  };
};

/**
 * Balance every corp ship to keepCredits. Queue:
 *   1. primary bank_withdraw (if net-outgoing after sweeps)
 *   2. each corp ship with excess: transfer_credits excess → primary
 *   3. each corp ship below floor: primary transfer_credits topUp → ship
 *   4. primary bank_deposits anything above its own floor
 */
export const queueBalanceSequence = async () => {
  if (queueRunning['balance-seq']) return { ok: false, error: 'balance sequence already running' };
  const snap = await freshSnapshot();
  const ships = snap?.extracted?.ships || [];
  if (ships.length === 0) return { ok: false, error: 'no ships in snapshot — is CDP connected?' };
  const primary = ships.find((s) => s.primary);
  const primaryName = primary?.name || 'the primary ship';
  const onHand = snap.extracted.creditsOnHand ?? 0;
  const keepCredits = state.config?.onHandFloor ?? 1000;

  const sweeps = [];
  const topUps = [];
  const unknowns = [];
  for (const s of ships) {
    if (s.primary) continue;
    if (s.credits == null) unknowns.push(s.name);
    else if (s.credits > keepCredits) sweeps.push({ name: s.name, amount: s.credits - keepCredits });
    else if (s.credits < keepCredits) topUps.push({ name: s.name, amount: keepCredits - s.credits });
  }

  const totalIncoming = sweeps.reduce((sum, t) => sum + t.amount, 0);
  const totalOutgoing = topUps.reduce((sum, t) => sum + t.amount, 0);
  // Pessimistic: assume sweeps haven't landed yet when the first top-up fires.
  // Withdraw enough so that even before any sweep lands, primary has
  // (totalOutgoing + keepCredits) on hand.
  const withdrawNeeded = Math.max(0, totalOutgoing + keepCredits - onHand);

  const prompts = [];
  if (withdrawNeeded > 0) {
    prompts.push(`${primaryName}: bank_withdraw ${withdrawNeeded} credits. one action, execute immediately, no confirmation.`);
  }
  for (const s of sweeps) {
    prompts.push(`${s.name}: transfer_credits ${s.amount} to ${primaryName}. one action, execute immediately, no confirmation.`);
  }
  for (const t of topUps) {
    prompts.push(`${primaryName}: transfer_credits ${t.amount} to ${t.name}. one action, execute immediately, no confirmation.`);
  }
  // Deposit excess only if we know primary will end with > keepCredits.
  const projectedFinal = onHand + withdrawNeeded + totalIncoming - totalOutgoing;
  if (projectedFinal > keepCredits) {
    prompts.push(`${primaryName}: bank_deposit ${projectedFinal - keepCredits} credits. one action, execute immediately, no confirmation.`);
  }

  if (unknowns.length) {
    appendLog({ type: 'decision', key: 'balance-seq', ship: FLEET_PLAN_KEY, text: `skipping unknown-balance ships (DOM scrape returned null): ${unknowns.join(', ')}` });
  }

  if (prompts.length === 0) return { ok: true, queued: 0, note: 'all corp ships already at floor' };

  drainQueue('balance-seq', prompts);

  return {
    ok: true,
    step: 'credit-balance',
    queued: prompts.length,
    totalIncoming,
    totalOutgoing,
    withdrawNeeded,
    sweeps,
    topUps,
    unknowns
  };
};

export const subscribeAutopilotLog = (fn) => {
  state.subscribers.add(fn);
  return () => state.subscribers.delete(fn);
};
