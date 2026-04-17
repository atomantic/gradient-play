import { getGameSnapshot, sendAssistantPrompt, clickGameReconnect, loginIfNeeded, getMapSectors } from './cdp.js';
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
const standingOrders = (shipName = '', { isProbe = false, creditKeep = 1000, tradeFallback = false } = {}) => {
  const cfg = state.config || {};
  const bad = dangerousSectors();
  const parts = [];
  if (cfg.safeMode && !isProbe) {
    // For trade dispatches, allow a small excursion outside fedspace when no
    // fedspace port will buy the cargo — otherwise the hauler cycles through
    // full/sated fedspace buyers forever. Hard fedspace stays the default for
    // everything else (rescues, upgrades, bank sweeps).
    parts.push(tradeFallback
      ? `fedspace first; +1-2 border hops OK only if no fedspace buyer accepts the cargo; keep warp to return to a megaport (${megaportList()})`
      : 'fedspace');
  }
  if (bad.length) parts.push(`avoid ${bad.slice(0, 6).join(',')}`);
  parts.push('avoid tolls');
  if (isProbe) parts.push('bank all credits');
  else if (creditKeep > 0) parts.push(`bank >${creditKeep}`);
  parts.push('execute now');
  return ` [${parts.join('; ')}]`;
};

// Appended to prompts that should run inline in chat instead of occupying a
// task slot. Earlier wording ("no new task — interactive only") made the
// agent think the instruction itself was forbidden ("banking requires a
// formal task according to standard protocol"). The new phrasing mirrors
// the fleet-plan prompts that reliably succeed — an imperative "do this
// now" with no reference to the task system at all.
const interactiveOnlyClause = () => ' [execute immediately, no confirmation]';

const refuelPrompt = (ship, warp) => pick([
  `refuel ${ship} at hub ${homeHub()} (${warp} warp)`,
  `${ship}: ${warp} warp, head to hub ${homeHub()} to refuel`,
  `recall ${ship} to hub ${homeHub()} for refuel (${warp} warp)`
]) + standingOrders(ship);

/**
 * Ship is already docked at a megaport with low warp. No rescue needed —
 * the ship can just call recharge_warp_power right there. If it's low on
 * credits, the primary funds it — BUT only works when both ships are docked
 * at the same megaport (transfer_credits requires co-location).
 */
const rechargeAtPortPrompt = (ship, sector, warp, credits, primaryName, primarySector) => {
  const needsFunding = credits != null && credits < 1000;
  if (!needsFunding) {
    return `${ship} @${sector} (${warp} warp) is docked at a megaport. call recharge_warp_power to full right now — it has credits. execute immediately, no confirmation.`;
  }
  const topUp = 1000 - credits;
  if (primarySector === sector) {
    return `${ship} @${sector} (${warp} warp) is docked and broke. ${primaryName} is at the same port. sequence: ${primaryName} bank_withdraw ${topUp} if on-hand is short, then transfer_credits ${topUp} to ${ship}, then ${ship} recharge_warp_power to full. one action at a time, execute immediately.`;
  }
  // Different megaport → transfer_credits won't work without co-location.
  // The cheapest move is to route the primary to the stranded ship's port
  // (the stranded ship is already low on warp; primary has more fuel).
  return `${ship} @${sector} (${warp} warp) is docked at a megaport but broke, and ${primaryName} is at a different port. transfer_credits requires same-port co-location, so: 1) ${primaryName} plot_course to sector ${sector} and dock. 2) ${primaryName} bank_withdraw ${topUp} if needed, transfer_credits ${topUp} to ${ship}. 3) ${ship} recharge_warp_power to full. one action at a time, execute immediately.`;
};

/**
 * Fleet-fuel emergency: primary is stranded and a corp ship still has
 * enough warp to reach it. Dispatch the savior to primary's sector,
 * transfer warp, then primary heads to hub. Priority over every other
 * rescue because the primary is the bank-access linchpin — once it's
 * fueled and docked it can fund and refuel every stranded corp ship.
 */
const primaryReviveDispatchPrompt = (savior, saviorWarp, primary, primarySector, primaryWarp) => {
  const loc = primarySector != null ? `@${primarySector}` : `(exact sector unknown, use plot_course with the primary as target)`;
  const hub = homeHub();
  return `PRIMARY FUEL EMERGENCY. ${savior} (${saviorWarp} warp) is the only ship with enough fuel to reach the primary. sequence: 1) ${savior} plot_course to primary ${primary} ${loc}. 2) ${savior} transfer_warp_power ${Math.min(200, Math.floor(saviorWarp / 2))} to ${primary}. 3) ${primary} plot_course to hub ${hub} and dock. 4) ${primary} recharge_warp_power. queue one at a time, execute immediately, no confirmation.`;
};

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

const probeTaskPrompt = (probe, role, target) => {
  const verb = role === 'scavenger' ? 'salvaging' : 'exploring';
  const where = target != null
    ? ` starting at sector ${target}`
    : '';
  // Nudge the agent toward the right discovery tool. local_map_region(depth=3)
  // returns the adjacent unvisited sectors; without this reminder the agent
  // sometimes wanders via plot_course + my_status guesswork and re-visits
  // known hexes.
  return `send ${probe} as far as it can go ${verb} new sectors until it runs out of fuel${where}. use local_map_region each hop to pick the nearest unvisited neighbor. prefer unvisited hops; if all neighbors are already known, transit through known sectors to reach fresh territory — do not halt just because the immediate neighbors are visited. do not turn back to refuel — the primary will remote-sell it when the run is over.`
    + standingOrders(probe, { isProbe: true });
};

const probeExplorePrompt = (probe, target) => probeTaskPrompt(probe, 'explorer', target);
const scavengerPrompt = (scav, target) => probeTaskPrompt(scav, 'scavenger', target);
const explorerPrompt = (expl, target) => probeTaskPrompt(expl, 'explorer', target);

const haulerTradePrompt = (hauler) => {
  const route = state.config?.haulerPreferredRoute;
  if (route?.buyAt != null && route?.sellAt != null && route?.commodity) {
    const note = route.note ? ` ${route.note}.` : '';
    return `${hauler}: PREFERRED ROUTE — buy ${route.commodity} at sector ${route.buyAt}, sell at sector ${route.sellAt}, repeat.${note} fill cargo on every buy. if stock depletes below profitability, fall back to a short fedspace NS loop. coordinate timing with fleetmate traders on the same megaport.` + standingOrders(hauler);
  }
  return pick([
    `${hauler}: fedspace NS loop, 2-3 hops, max cr/warp. rotate on depletion, no fleetmate port overlap.`,
    `${hauler}: 2-3 hop NS trade in fedspace. rank cr/warp, rotate routes, stagger from fleetmates.`,
    `${hauler}: NS loop fedspace, 2-3 hops. optimize cr/warp, rotate on stock drop, avoid fleetmate ports.`
  ]) + standingOrders(hauler);
};

// The agent categorically refuses to run bank_deposit interactively — its
// standing rule is "banking operations require a dedicated task." So we
// frame the sweep as a one-shot bank task instead of an inline command.
// This consumes a task slot; `pushTaskDecision` (not pushInteractive) is
// the correct dispatch path. IMPORTANT: name the primary ship explicitly —
// ex.creditsOnHand is the PLAYER'S top-bar balance, which only the primary
// can deposit. Without a name the agent has handed this task to whichever
// ship it felt like (e.g., a hauler that didn't actually hold the excess).
const bankSweepPrompt = (primary, excess, onHand, floor) => pick([
  `${primary}: bank task — dock at the nearest megaport, bank_deposit ${excess} credits from on-hand, keep ${floor} on hand, then resume your previous activity.`,
  `${primary}: quick bank run — route to a megaport, bank_deposit ${excess} credits (keep ${floor} on hand), resume trading after.`,
  `${primary}: banking task — bank_deposit ${excess} credits at next dock, hold ${floor} on hand, then return to previous route.`
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

const primaryTradePrompt = (primary) => {
  const route = state.config?.primaryPreferredRoute;
  if (route?.buyAt != null && route?.sellAt != null && route?.commodity) {
    const note = route.note ? ` ${route.note}.` : '';
    return `${primary}: PREFERRED ROUTE — buy ${route.commodity} at sector ${route.buyAt}, sell at sector ${route.sellAt}, repeat.${note} if stock depletes below profitability, fall back to a short fedspace NS loop; coordinate timing with fleetmate traders on the same megaport.` + standingOrders(primary);
  }
  return pick([
    `${primary}: fedspace NS loop, 2-3 hops, max cr/warp. rotate on depletion, no fleetmate port overlap.`,
    `${primary}: 2-3 hop NS trade in fedspace. rank cr/warp, rotate routes, stagger from fleetmates.`,
    `${primary}: NS loop fedspace, 2-3 hops. optimize cr/warp, rotate on stock drop, avoid fleetmate ports.`
  ]) + standingOrders(primary);
};

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

// Per-user config overrides loaded from data/config.json (git-ignored). This
// is how individual corp members set their own isCeo flag, homeHub, etc.
// without committing their state to the shared codebase. Applied as the last
// merge layer in startAutopilot so it always wins over incoming UI config —
// one authoritative source of truth per checkout.
import { existsSync as _existsSync, readFileSync as _readFileSync } from 'node:fs';
import { dirname as _dirname, resolve as _resolve } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
const USER_CONFIG_PATH = _resolve(_dirname(_fileURLToPath(import.meta.url)), '..', 'data', 'config.json');
const loadUserOverrides = () => {
  if (!_existsSync(USER_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(_readFileSync(USER_CONFIG_PATH, 'utf8'));
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch (err) {
    console.error(`[autopilot] failed to parse ${USER_CONFIG_PATH}: ${err.message}`);
    return {};
  }
};

const DEFAULTS = {
  pollIntervalSec: 60,
  minWarp: 50,                    // below this: normal refuel (ship can still reach a megaport)
  dispatchMinWarp: 200,           // idle ships below this get refueled instead of dispatched — prevents stranding
  fuelCriticalWarp: 15,           // below this: emergency — request transfer_warp_power rescue
  refuelCooldownSec: 180,         // per-ship: re-nag every 3 min if warp stays low
  rescueCooldownSec: 90,          // per-ship: re-nag every 90s if stranded
  creditsForRefuel: 1000,         // credits to transfer to a corp ship before recharge if it's broke (~1000 = full probe recharge)
  // Working-capital floors. A single NS trade on a Wayfarer/Atlas can cost
  // 3-5k cr; even on a Kestrel a primary trade costs ~1500. Keep enough
  // on-hand that a buy doesn't strand the ship at zero credits. Override
  // per-account via data/config.json if you're flying a bigger hull.
  shipFundingFloor: 3000,         // minimum credits a ship should have before dispatch — seed from primary if below
  onHandFloor: 5000,              // working float to keep on-hand on every ship (covers a single ~1500 cr trade plus buffer)
  depositExcessOver: 5000,        // trigger sweep when on-hand is floor+this (so 10k → deposit 5k, leave 5k)
  decisionCooldownSec: 420,       // 7 min — longer than a typical refuel or task handoff
  considerUpgrades: true,
  upgradeCreditsThreshold: 100000,
  corpTaskCap: 3,                 // fallback if DOM taskSlots.total isn't reported
  probeSlots: 1,                   // 1 probe for map expansion (explorer or scavenger)
  tradeSlots: 2,                   // 2 corp haulers on fedspace trade loops — primary income
  primaryDispatchCooldownSec: 300,  // 5 min — tight enough to refill the local slot quickly when a task ends
  // Optional: override the generic "NS loop" dispatch with specific arbitrage
  // routes. Shape: { buyAt, sellAt, commodity, note }. Two fields — one for
  // the primary ship, one for all corp haulers. Set via data/config.json.
  primaryPreferredRoute: null,
  haulerPreferredRoute: null,
  megaports: [305, 472, 1413],      // known mega-port sectors — add more as probes discover them
  homeHub: 1413,                    // preferred dock for fuel/banking — the fleet's home base
  safeMode: true,                  // restrict non-probe ships to federation space
  // CEO mode: autopilot dispatches corp ships. Default off so cloned checkouts
  // don't stomp on a corp's task slots. Override per-user via data/config.json.
  isCeo: false,
  troubleMaker: false,             // reckless mode: primary leaves fedspace for salvage + combat + frontier trading
  maxDecisionsPerTick: 2,          // never fire more than N prompts in one tick — avoids flooding the agent
  interPromptDelayMs: 12_000,      // pause between consecutive prompts in the same tick so the agent finishes the previous action before the next arrives
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
  prevWarp: new Map(), // ship name → last-tick warp, used to detect in-flight ships
  stuckTicks: 0,       // consecutive ticks with ≥2 ships at critical warp — triggers AI advisor
  lastAdvisorAt: 0,    // ms timestamp of last advisor dispatch (30-min cooldown)
  // User-issued travel intents: ship name → { sector, issuedAt, msgTs }.
  // The game caps autonomous tasks at 100 steps, so a ship routing to a distant
  // sector will halt mid-transit. If the user told us where it was going, we
  // auto-reissue a continue directive on task-max-steps until the ship arrives.
  travelIntents: new Map()
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
      markSeen(key);
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

// Matches user directives like "send X to sector 1413", "route refueler to 305",
// "continue hauler toward 1413", "move probe to 472". Captures the ship-role
// phrase (possibly multi-ship: "refueler and explorer") and the sector number.
const TRAVEL_INTENT_RE = /(?:send|route|move|continue|dispatch|head)\s+(?:the\s+)?([a-z0-9,\s&-]+?)\s+(?:back\s+)?(?:to|toward|towards)\s+(?:sector\s+)?(\d{2,5})\b/i;

const parseTravelIntents = (snapshot) => {
  const msgs = snapshot?.extracted?.lastMessages || [];
  const ships = snapshot?.extracted?.ships || [];
  const intents = [];
  for (const m of msgs) {
    if (!m) continue;
    if (!/USER[:\s]/i.test(m)) continue;
    const match = m.match(TRAVEL_INTENT_RE);
    if (!match) continue;
    const sector = parseInt(match[2], 10);
    if (!Number.isFinite(sector)) continue;
    const tsMatch = m.match(/\[(\d{2}:\d{2}:\d{2})\]/);
    const msgTs = tsMatch ? tsMatch[1] : null;
    const roles = match[1].split(/,\s*|\s+and\s+|\s*&\s*/i).map((s) => s.trim()).filter(Boolean);
    for (const role of roles) {
      const ship = matchShipByRole(role, ships);
      if (!ship) continue;
      const key = `travel-intent:${ship.name}:${sector}:${msgTs || m.slice(0, 40)}`;
      if (state.seenEventKeys.has(key)) continue;
      markSeen(key);
      intents.push({ ship: ship.name, sector, msgTs, roleWord: role });
    }
  }
  return intents;
};

const appendLog = (entry) => {
  const stamped = { ts: Date.now(), ...entry };
  state.log.push(stamped);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  for (const fn of state.subscribers) fn(stamped);
};

// Dedup keys grow per-event (travel-resume keys include a timestamp, auto-
// confirm keys include a 60-char message slice), so the set would grow
// indefinitely over a multi-day session. Cap it and drop the oldest entries
// when we blow the ceiling — Set preserves insertion order.
const SEEN_KEY_CAP = 2000;
const markSeen = (key) => {
  state.seenEventKeys.add(key);
  if (state.seenEventKeys.size > SEEN_KEY_CAP) {
    const drop = state.seenEventKeys.size - SEEN_KEY_CAP;
    const it = state.seenEventKeys.values();
    for (let i = 0; i < drop; i++) state.seenEventKeys.delete(it.next().value);
  }
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

// The refueler probe patrols the rim of federation space. It dips into
// adjacent neutral sectors hunting salvage, then returns to the nearest
// megaport the moment it finds any — recharge_warp_power paid from the
// salvage credits, remainder banked. Self-sustaining: unlike the explorer,
// this probe does NOT run dry; it manages its own fuel cycle.
const refuelerEdgePatrolPrompt = (refueler) => {
  const combat = `flee all combat — do NOT engage. snipe salvage and retreat; never attack.`;
  const range = `work the fedspace rim and up to 3 hops into adjacent neutral space — no deeper`;
  const tolls = `HARD RULE: NEVER enter a toll sector and NEVER enter a sector with a hostile garrison. before plotting any course into neutral space, use local_map_region to check the destination and every hop along the route for garrisons/tolls — if ANY are present, abort and pick a different sector. NO salvage is worth a toll payment or a garrison hit. scan *near* tolls from the safe side only; if the only path to salvage goes through a toll, skip that salvage and move on.`;
  return pick([
    `${refueler}: fedspace-edge salvage patrol. ${range}. scan for salvage. ${tolls} ${combat} on any salvage find, immediately plot_course to the nearest megaport, recharge_warp_power first (pay from the salvage credits), then bank or transfer the leftover credits to the primary. resume patrol after refuel.`,
    `${refueler}: patrol the border between federation and neutral space. ${range}. scan for salvage. ${tolls} ${combat} when you grab any, head straight to the nearest megaport — refuel with the salvage credits, deposit the rest, then go back out.`,
    `${refueler}: edge salvager. ${range}. ${tolls} ${combat} any salvage claim means immediate return: nearest megaport, recharge_warp_power using the credits, bank the remainder, resume.`
  ]) + standingOrders(refueler, { isProbe: true });
};

/**
 * Remote-sell a stranded probe and replace it with a fresh one. strategy.md
 * §7: sell_ship only checks the caller's personal-ship location (megaport in
 * fedspace), not the probe's sector. Stranded probes at 0 warp deep in neutral
 * space can be sold remotely — the refund covers a new probe's full cost.
 * Fires as a one-shot interactive prompt; agent resolves the ship_id via
 * corporation_info() and handles the purchase.
 */
const probeReplacePrompt = (probeName, probeSector, probeWarp, primaryAtMegaport, hubSector, probeCredits) => {
  const loc = probeSector != null ? `@${probeSector}` : 'unknown sector';
  // REMOTE SELL: sell_ship only checks the CALLER's (primary's) sector, not the
  // target ship's sector. The probe stays put — it has 0 warp and cannot move
  // anyway. Past failures were caused by the agent assuming the probe itself
  // had to be at a megaport, so the prompt is now explicit: probe does not
  // travel, the primary handles the sell from its own megaport.
  const travel = primaryAtMegaport
    ? `your primary ship is already docked at a megaport — call sell_ship from here.`
    : `your primary ship is NOT at a megaport. PRIORITY: primary plot_course to sector ${hubSector} and dock first, then call sell_ship from there. interrupt any current trade task — this is more valuable than a single trade loop.`;
  const creditsNote = probeCredits != null && probeCredits > 0
    ? ` note: ${probeName} is holding ${probeCredits} salvage credits — sell_ship refunds those to you along with the hull value, so they're recovered automatically.`
    : '';
  return `${probeName} is stranded ${loc} at ${probeWarp ?? 0} warp — recycle it via REMOTE SELL. DO NOT move ${probeName}; it has no warp and cannot travel. sell_ship only checks the primary's sector, so the primary calls it remotely on ${probeName}.${creditsNote} ${travel} sequence (primary performs all steps): 1) corporation_info to fetch ${probeName}'s ship_id. 2) sell_ship(ship_id=<${probeName}'s hex prefix>) — refund covers hull (~1000 cr) + any credits ${probeName} was holding. 3) ship_purchase a new Autonomous Probe. 4) start_task to dispatch the fresh probe on exploration. one action at a time, execute immediately, no confirmation.`;
};

/**
 * BFS through visited known sectors from `fromSectorId`, returning the nearest
 * unvisited sector (or an unknown adjacent sector) as the frontier target.
 * `excludeIds` prevents assigning the same frontier to two probes in one tick.
 * Returns null if no frontier is reachable through known space.
 */
export const findNearestFrontier = (sectors, fromSectorId, excludeIds = new Set()) => {
  if (!Array.isArray(sectors) || fromSectorId == null) return null;
  const by = new Map(sectors.map((s) => [s.id, s]));
  if (!by.has(fromSectorId)) return null;
  const dist = new Map([[fromSectorId, 0]]);
  const queue = [fromSectorId];
  while (queue.length) {
    const cur = queue.shift();
    const curDist = dist.get(cur);
    const node = by.get(cur);
    if (!node) continue;
    for (const nb of node.adj || []) {
      if (dist.has(nb)) continue;
      if (excludeIds.has(nb)) { dist.set(nb, curDist + 1); continue; }
      const nbNode = by.get(nb);
      if (!nbNode || !nbNode.visited) {
        return { sector: nb, hops: curDist + 1 };
      }
      dist.set(nb, curDist + 1);
      queue.push(nb);
    }
  }
  return null;
};

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
const decide = async (snapshot) => {
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
  // Refueler probe now runs fedspace-edge salvage patrols (see
  // refuelerEdgePatrolPrompt) — it's no longer a rescue ship. Stranded
  // corpmates fall back to the generic rescue prompt (any fueled corpmate).
  const megaportSet = new Set(megaportSectors());
  const primaryShip = ships.find((s) => s.primary);
  const primaryName = primaryShip?.name || 'the primary ship';
  // Primary is "available" when it's present, idle (no autonomous task), and
  // not currently steering a plan. Several downstream dispatches gate on this
  // so we don't stack a new order on top of in-progress work.
  const primaryAvailable = !!primaryShip
    && primaryShip.active === false
    && !hasPlan(primaryShip.name);

  // PRIMARY FUEL EMERGENCY. If the primary is at/below critical warp, saving
  // it takes priority over every other rescue: the primary has bank access
  // and is the only ship that can fund the rest of the fleet for recharges.
  // Pick the most-fueled corp ship with enough warp to reach the primary
  // (conservative threshold: 2× criticalWarp + a 100-warp buffer), dispatch
  // it to transfer_warp_power to primary, then primary heads to hub.
  //
  // CEO-only. A non-CEO autopilot shouldn't direct corp ships (shared task
  // slots would trample another corp member's commands). When non-CEO the
  // user must coordinate the rescue manually from the in-game chat.
  if (ceo && cfg.enabled.refuel && primaryShip && primaryShip.warpPower != null
      && primaryShip.warpPower < cfg.fuelCriticalWarp
      && !hasPlan(primaryShip.name)) {
    const MIN_SAVIOR_WARP = Math.max(200, cfg.fuelCriticalWarp * 2 + 100);
    // Prefer an idle savior; only bump an active corp ship off its task if no
    // idle option has enough fuel. Primary-fuel emergency is the only thing
    // that justifies interrupting a running corp task.
    const fuelCandidates = ships
      .filter((c) => !c.primary && c.warpPower != null && c.warpPower >= MIN_SAVIOR_WARP && !hasPlan(c.name))
      .sort((a, b) => (b.warpPower || 0) - (a.warpPower || 0));
    const savior = fuelCandidates.find((c) => c.active !== true) || fuelCandidates[0];
    if (savior) {
      const key = `primary-revive:${primaryShip.name}`;
      if (canAct(key, cfg.rescueCooldownSec * 1000)) {
        pushInteractive({
          key,
          ship: savior.name,
          text: primaryReviveDispatchPrompt(savior.name, savior.warpPower, primaryShip.name, primaryShip.sector, primaryShip.warpPower)
        });
      }
    }
    // Either way, skip other rescue logic for the primary this tick — the
    // emergency prompt above owns its revival. Continue with corp-ship fuel
    // guards below (ships at hub can still self-recharge).
  }

  for (const s of ships) {
    if (!cfg.enabled.refuel) continue;
    if (s.warpPower == null) continue;
    if (hasPlan(s.name)) continue; // plan owns this ship's next action
    if (!ceo && !s.primary) continue; // non-CEO: don't touch corp ships
    // Primary emergency already handled above — don't double-prompt it.
    if (s.primary && s.warpPower < cfg.fuelCriticalWarp) continue;
    // Probes are disposable: strategy.md §7 says run them dry and remote-sell
    // from the primary's next megaport visit. Don't rescue, don't route to
    // refuel — the probe-replacement decision below owns stranded probes.
    // Refuelers are an exception (they need warp to rescue other ships).
    if (shipKind(s.name) === 'probe' && probeRole(s.name) !== 'refueler') continue;
    if (s.warpPower < cfg.fuelCriticalWarp) {
      // FAST PATH: ship is already docked at a megaport. No rescue needed —
      // just recharge in place (primary funds it first if broke). This avoids
      // the stuck-at-hub-begging-for-a-corpmate-rescue loop seen in overnight
      // logs when most of the fleet is simultaneously dry.
      if (s.sector != null && megaportSet.has(s.sector)) {
        const key = `recharge-at-port:${s.name}`;
        if (canAct(key, cfg.rescueCooldownSec * 1000)) {
          pushInteractive({ key, ship: s.name, text: rechargeAtPortPrompt(s.name, s.sector, s.warpPower, s.credits, primaryName, primaryShip?.sector) });
        }
        continue;
      }
      // Stranded in space. Fire the generic rescue prompt only when at least
      // one corpmate still has enough warp to help AND is available (idle,
      // not under a plan). Otherwise the prompt is a no-op that confuses the
      // agent (the overnight failure mode: 5 of 6 ships dry, no corpmate to
      // transfer from — or the only fueled corpmate is mid-trade).
      const anyCorpmateAvailable = ships.some((c) => !c.primary && c.name !== s.name
        && c.warpPower != null && c.warpPower >= Math.max(200, cfg.minWarp * 2)
        && c.active !== true && !hasPlan(c.name));
      if (anyCorpmateAvailable) {
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
          const plan = buildRefuelPlan(s, { creditsForRefuel: cfg.creditsForRefuel, megaports: megaportSectors() });
          slotBudget -= 1;
          out.push({ key: `plan-create:refuel:${s.name}`, ship: s.name, createPlan: plan, createsTask: true });
        }
      }
    }
  }

  // Probe replacement: when a non-refueler probe is idle with warp too low to
  // re-dispatch (under dispatchMinWarp), fire a one-shot prompt telling the
  // primary to remote-sell + repurchase. strategy.md §7: sell_ship only
  // checks the caller's personal-ship location — the probe can be anywhere,
  // including stranded at 0 warp in neutral space. The prompt includes a
  // "travel to megaport first if needed" clause so it works whether the
  // primary is docked or mid-trade. Net cost is ~0 (sell refund covers new
  // probe), and the fresh probe comes with full warp.
  //
  // Guard: if the probe is holding salvage credits (credits > 0), skip
  // auto-replace and log a notice — the user may want to inspect or keep the
  // ship_id alive. sell_ship DOES refund those credits, so this guard is
  // conservative; remove it if you want fully-automatic recycling.
  // Only scrap a probe when it's effectively DRY (≤10 warp). Residual warp
  // is wasted credits on sell (sell refund is hull-based, not fuel-based),
  // so we keep re-dispatching probes until they burn through. The dispatch
  // loop uses PROBE_MIN_DISPATCH_WARP=10 so probes with 10-199 warp keep
  // getting new tasks — only when they hit the near-zero floor do we sell.
  if (ceo && cfg.enabled.refuel && primaryShip) {
    const SCRAP_WARP_CEILING = 10;
    const primaryAtMegaport = primaryShip.sector != null && megaportSet.has(primaryShip.sector);
    for (const s of ships) {
      if (s.primary) continue;
      if (shipKind(s.name) !== 'probe') continue;
      if (probeRole(s.name) === 'refueler') continue;
      if (s.warpPower == null || s.warpPower > SCRAP_WARP_CEILING) continue;
      if (s.active === true) continue; // still executing a task — wait for it to end
      if (hasPlan(s.name)) continue;
      // sell_ship refunds both the hull value AND any credits the probe is
      // holding, so salvage funds are recovered automatically by the sell.
      // The replace prompt flags the credit amount for visibility.
      const key = `probe-replace:${s.name}`;
      if (!canAct(key, cfg.rescueCooldownSec * 1000)) continue;
      pushInteractive({
        key,
        ship: primaryShip.name,
        text: probeReplacePrompt(s.name, s.sector, s.warpPower, primaryAtMegaport, homeHub(), s.credits)
      });
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
  const activeProbeCount = activeCorp.filter((s) => shipKind(s.name) === 'probe').length;

  // Idle ships must have enough warp to meaningfully execute a new task.
  // Haulers/traders use dispatchMinWarp (~200) so they don't strand mid-trade.
  // Probes use a much lower floor (10 warp) — the explorer's directive is
  // literally to run dry, so we want to keep re-dispatching it on every leftover
  // drop of warp until it hits 0, at which point the probe-replace path
  // scraps it. Anything below 10 is too low to be productive.
  const PROBE_MIN_DISPATCH_WARP = 10;
  const haulerMinWarp = cfg.dispatchMinWarp ?? cfg.minWarp;
  const idleProbes = corpShips.filter((s) =>
    s.active === false
    && shipKind(s.name) === 'probe'
    && s.warpPower != null
    && s.warpPower >= PROBE_MIN_DISPATCH_WARP
  );
  const idleHaulers = corpShips.filter((s) =>
    s.active === false
    && ['hauler', 'trader-light'].includes(shipKind(s.name))
    && s.warpPower != null
    && s.warpPower >= haulerMinWarp
  );
  const idleCorp = [...idleProbes, ...idleHaulers];

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

  // Probe dispatch: fleet has two active probe roles:
  //   - explorer  → pushes into unknown space until dry; remote-sold at primary's next megaport visit
  //   - refueler  → patrols fedspace-edge for salvage, self-refuels on find
  // probeSlots caps concurrent probe tasks (typically 2).
  const probeTarget = cfg.probeSlots ?? 2;
  const allIdleProbes = idleCorp.filter((s) => shipKind(s.name) === 'probe');
  allIdleProbes.sort((a, b) => (b.warpPower || 0) - (a.warpPower || 0));
  const needsRescue = out.some((d) => d.key?.startsWith('rescue:'));
  let probesSent = activeProbeCount;

  // Load the sector map once per tick if any *explorer* probe will be
  // dispatched (BFS computes its starting frontier). Refuelers don't need
  // the map — they patrol the fedspace rim which the agent already knows.
  let mapSectors = null;
  const explorerProbesEligible = allIdleProbes.filter((p) => probeRole(p.name) !== 'refueler').slice(0, probeTarget);
  if (!skipCorpWork && cfg.enabled.explore && explorerProbesEligible.length > 0) {
    const map = await getMapSectors().catch((e) => ({ ok: false, error: e.message }));
    if (map.ok) mapSectors = map.sectors;
    else appendLog({ type: 'event', intelType: 'map-fetch-failed', snippet: map.error });
  }
  const assignedFrontiers = new Set();

  // Credit-seeding guard: if an idle corp ship is at the home hub with less
  // than shipFundingFloor credits, fund it before dispatch. Skip dispatch this
  // tick — next tick the ship will have credits and can be dispatched then.
  // transfer_credits only works when both ships are docked at the same
  // megaport, so primary must also be at the hub — otherwise the fund prompt
  // silently fails at the game layer and burns its cooldown.
  const fundingFloor = cfg.shipFundingFloor ?? cfg.creditsForRefuel ?? 1000;
  const primaryCanFund = primaryAvailable && primaryShip.sector === homeHub();
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
    const role = probeRole(probe.name);
    // Fund first if at hub and broke. Refueler especially needs operating
    // credits (it pays for its own recharge_warp_power from salvage/seed).
    if (needsFunding(probe)) {
      if (!primaryCanFund) continue; // primary not co-located/idle — wait
      const key = `fund:${probe.name}`;
      if (canAct(key, cfg.refuelCooldownSec * 1000)) {
        pushInteractive({ key, ship: probe.name, text: shipFundPrompt(probe.name, probe.credits, fundingFloor) });
      }
      continue; // skip dispatch this tick
    }
    const key = `${role || 'explore'}:${probe.name}`;
    if (!canAct(key, cooldownMs)) continue;
    let text;
    if (role === 'refueler') {
      // Refueler patrols the fedspace rim — no frontier BFS, no unknown-space
      // targeting. The edge-patrol prompt describes its self-refuel cycle.
      text = refuelerEdgePatrolPrompt(probe.name);
    } else {
      // Explorer/scavenger/unknown: compute nearest unvisited frontier hex
      // from the probe's current sector via BFS through visited space.
      // Frontiers already assigned to other probes this tick are excluded.
      let frontier = null;
      if (mapSectors && probe.sector != null) {
        frontier = findNearestFrontier(mapSectors, probe.sector, assignedFrontiers);
        if (frontier) assignedFrontiers.add(frontier.sector);
      }
      const target = frontier?.sector ?? null;
      if (role === 'explorer') text = explorerPrompt(probe.name, target);
      else if (role === 'scavenger') text = scavengerPrompt(probe.name, target);
      else text = probeExplorePrompt(probe.name, target);
    }
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
      if (!primaryCanFund) continue; // primary not co-located/idle — wait
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
    // Hard floor: never sweep until the primary is clearly carrying excess
    // risk (>10k on-hand). Guards against drifted config values — if
    // someone sets onHandFloor low and depositExcessOver low, this prevents
    // a spurious sweep from firing on trivial balances.
    const BANK_SWEEP_MIN_ON_HAND = 10_000;
    if (onHand > BANK_SWEEP_MIN_ON_HAND && excess >= cfg.depositExcessOver) {
      const key = 'bank:sweep';
      // The agent rejects banking as an interactive action ("requires a
      // dedicated task"), so dispatch this as a task. Gating on
      // primaryAvailable keeps the sweep from landing on an active trade
      // loop — the prompt's "resume your previous activity" suffix is
      // unreliable when the agent is mid-task.
      if (primaryAvailable && canAct(key, cooldownMs)) {
        pushTaskDecision({
          key,
          ship: primaryName,
          text: bankSweepPrompt(primaryName, excess, onHand, cfg.onHandFloor)
        });
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

  // Upgrade: fire when (a) we know the ship's next tier and (b) we can
  // actually afford it. Ship ladder lives in code (from strategy.md) so we don't
  // ask the agent to look anything up. Both primary and corp haulers are eligible —
  // haulers are our main income stream, so upgrading them to larger cargo hulls
  // compounds trade revenue.
  if (cfg.enabled.upgrade && cfg.considerUpgrades) {
    const bank = ex.creditsBank ?? 0;
    const onHand = ex.creditsOnHand ?? 0;
    const total = bank + onHand;
    const upgradeCandidates = [];
    if (ex.shipName) upgradeCandidates.push({ name: ex.shipName, role: 'primary' });
    if (ceo) {
      for (const s of corpShips) {
        if (['hauler', 'trader-light'].includes(shipKind(s.name))) {
          upgradeCandidates.push({ name: s.name, role: 'hauler' });
        }
      }
    }
    for (const cand of upgradeCandidates) {
      const next = findNextUpgrade(cand.name);
      if (!next) continue;
      if (total < (next.netCost ?? next.price)) continue;
      const key = `upgrade:${cand.name}`;
      if (!canAct(key, cooldownMs * 2)) continue;
      pushInteractive({ key, text: upgradePrompt(cand.name, total, next) });
      break; // one upgrade at a time — bank spends on the first eligible candidate
    }
  }

  // Keep the local task engine (primary ship) slot in use.
  // Prefer the DOM's "N/M SLOTS USED" counter — it's authoritative and covers
  // the primary's local slot. Scraped ENGINE STATUS cards can briefly drop the
  // WORKING flag during handoff, which caused spurious re-dispatch on top of
  // an already-running primary task.
  if (cfg.enabled.primary && ex.shipName) {
    const primary = ships.find((s) => s.primary);
    const workingTaskCount = (ex.tasks || []).filter((t) => t.working).length;
    const activeCorpCount = activeCorp.length;
    const primaryTaskCount = ex.taskSlots?.used != null
      ? Math.max(0, ex.taskSlots.used - activeCorpCount)
      : Math.max(0, workingTaskCount - activeCorpCount);
    const primaryHasTask = primaryTaskCount > 0;

    // Probe-replace race guard: if any probe-replace was dispatched in the
    // last 3 min, the primary is likely mid-sequence (route → sell → buy →
    // start_task). Don't hand it a new trade task on top of that — it causes
    // the agent to drop the replacement mid-flight.
    const now = Date.now();
    const probeReplaceRecent = [...state.lastDecisionAt.entries()]
      .some(([k, ts]) => k.startsWith('probe-replace:') && (now - ts) < 3 * 60_000);

    if (
      primary &&
      !primaryHasTask &&
      !probeReplaceRecent &&
      primary.warpPower != null &&
      // Use dispatchMinWarp (~200) not minWarp (~50): at 50 warp the primary
      // could start a trade loop and strand itself mid-hop before returning
      // to refuel. 200 gives comfortable round-trip headroom.
      primary.warpPower >= (cfg.dispatchMinWarp ?? cfg.minWarp) &&
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

    // Track user travel directives ("send X to 1413", "continue X toward 305")
    // so we can auto-reissue on task-max-steps — the game caps any autonomous
    // task at 100 steps, so long-haul travel halts mid-transit.
    const shipsNow = snapshot?.extracted?.ships || [];
    // Shared critical-warp scan: reused by the auto-confirm crisis guard and
    // the deadlock detector below so we don't walk the fleet twice per tick.
    const criticalCount = shipsNow.filter((s) => s.warpPower != null && s.warpPower < state.config.fuelCriticalWarp).length;
    const newIntents = parseTravelIntents(snapshot);
    for (const t of newIntents) {
      state.travelIntents.set(t.ship, { sector: t.sector, issuedAt: Date.now(), msgTs: t.msgTs });
      appendLog({ type: 'event', intelType: 'travel-intent', ship: t.ship, sector: t.sector, roleWord: t.roleWord });
    }
    // Fulfilled → drop the intent.
    for (const [name, intent] of state.travelIntents) {
      const s = shipsNow.find((x) => x.name === name);
      if (s && s.sector === intent.sector) {
        state.travelIntents.delete(name);
        appendLog({ type: 'event', intelType: 'travel-intent-fulfilled', ship: name, sector: intent.sector });
      }
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
      // Auto-resume travel: 100-step cap halted the ship mid-transit. If we
      // tracked the user's destination and the ship isn't there yet, reissue.
      // Non-CEO autopilots only resume the primary — corp ships live on shared
      // task slots owned by the CEO's autopilot.
      if (ev.type === 'task-max-steps' || ev.type === 'task-aborted') {
        const intent = state.travelIntents.get(ev.ship);
        if (intent && (state.config?.isCeo || ev.isPrimary)) {
          const s = shipsNow.find((x) => x.name === ev.ship);
          const arrived = s && s.sector === intent.sector;
          if (arrived) {
            state.travelIntents.delete(ev.ship);
            appendLog({ type: 'event', intelType: 'travel-intent-fulfilled', ship: ev.ship, sector: intent.sector });
          } else if (s && s.warpPower != null && s.warpPower < state.config.minWarp) {
            // Don't push a low-fuel ship further — the refuel guard in decide()
            // will route it to a megaport. Intent is retained so we can resume
            // travel after refueling.
            appendLog({ type: 'event', intelType: 'auto-travel-resume-skip', ship: ev.ship, sector: intent.sector, snippet: `warp ${s.warpPower} below ${state.config.minWarp} — refuel first` });
          } else {
            const key = `travel-resume:${ev.ship}:${intent.sector}:${ev.msgTs || Date.now()}`;
            if (!state.seenEventKeys.has(key)) {
              markSeen(key);
              const prompt = `continue ${ev.ship} to sector ${intent.sector}, plot_course, dock on arrival, execute now`;
              sendAssistantPrompt(prompt).catch(() => {});
              appendLog({ type: 'event', intelType: 'auto-travel-resume', ship: ev.ship, sector: intent.sector, snippet: prompt });
            }
          }
        }
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
      // Crisis guard: if any ship is at critical warp, skip auto-confirm. The
      // agent's pending action could easily be wrong in a fuel crisis (e.g.
      // it may be asking to trade when what we actually need is a rescue). A
      // human should make the call rather than a blanket "yes, proceed".
      const fleetInCrisis = criticalCount > 0;
      if (isAskingForApproval && !userAlreadyReplied && !fleetInCrisis) {
        const key = `auto-confirm:${lastAssistantMsg.slice(0, 60)}`;
        if (!state.seenEventKeys.has(key)) {
          markSeen(key);
          await sendAssistantPrompt('yes, proceed').catch(() => {});
          appendLog({ type: 'event', intelType: 'auto-confirm', snippet: lastAssistantMsg.slice(0, 120) });
        }
      } else if (isAskingForApproval && !userAlreadyReplied && fleetInCrisis) {
        const key = `auto-confirm-skip:${lastAssistantMsg.slice(0, 60)}`;
        if (!state.seenEventKeys.has(key)) {
          markSeen(key);
          appendLog({ type: 'event', intelType: 'auto-confirm-skip', snippet: `fleet in critical-warp state — human confirmation required: ${lastAssistantMsg.slice(0, 100)}` });
        }
      }
    }

    // Process any active multi-step plans first — they own their ships' next
    // actions and suppress one-shot decide() dispatches for the same ship.
    await processPlans(snapshot);

    const decisions = await decide(snapshot);

    // Record current warp per ship so next tick can detect in-flight movement.
    for (const s of (snapshot?.extracted?.ships || [])) {
      if (s.name && s.warpPower != null) state.prevWarp.set(s.name, s.warpPower);
    }

    // Deadlock detector: if ≥2 ships stay at critical warp for ≥5 consecutive
    // ticks, fire an AI advisor run to suggest a recovery plan. 30-minute
    // cooldown on the dispatch so we don't spam the LLM. criticalCount was
    // computed once at the top of the tick and reused here.
    if (criticalCount >= 2) state.stuckTicks += 1;
    else state.stuckTicks = 0;
    const STUCK_THRESHOLD = 5;
    const ADVISOR_COOLDOWN_MS = 30 * 60 * 1000;
    if (state.stuckTicks >= STUCK_THRESHOLD && Date.now() - state.lastAdvisorAt > ADVISOR_COOLDOWN_MS) {
      state.lastAdvisorAt = Date.now();
      state.stuckTicks = 0; // reset so we don't re-fire every tick
      // Dynamic import avoids an autopilot ↔ advisor circular dependency.
      import('./advisor.js').then(({ adviseAutopilot }) =>
        adviseAutopilot({
          question: `Fleet has ${criticalCount} ships at critical warp for ${STUCK_THRESHOLD}+ consecutive ticks — looks like a fuel/credit deadlock the rescue loop can't resolve. Suggest a recovery sequence.`
        })
          .then((r) => appendLog({ type: 'event', intelType: 'advisor-dispatched', snippet: r.ok ? `runId=${r.runId} provider=${r.providerId} model=${r.model}` : `failed: ${r.error}`, runId: r.runId, providerId: r.providerId }))
          .catch((e) => appendLog({ type: 'error', error: `advisor dispatch failed: ${e.message}` }))
      );
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
    // flooding the agent's input with back-to-back prompts. When more than
    // one prompt fires in the same tick, we also pace them apart — the game
    // agent drops commands that arrive before it finishes the previous one.
    const maxPerTick = state.config.maxDecisionsPerTick ?? 2;
    const interPromptDelayMs = state.config.interPromptDelayMs ?? 12_000;
    const shipsPrompted = new Set();
    let promptsSent = 0;

    for (const d of decisions) {
      // Pace consecutive prompts: first send immediately, subsequent ones
      // wait for the agent to finish the previous command.
      if (promptsSent > 0 && interPromptDelayMs > 0) {
        await new Promise((r) => setTimeout(r, interPromptDelayMs));
      }
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
  // Merge order: codebase defaults → client/UI config → per-user overrides.
  // Overrides win so local state (e.g. isCeo, homeHub) doesn't get clobbered
  // by a fresh UI load on a different browser.
  const overrides = loadUserOverrides();
  state.config = {
    ...DEFAULTS,
    ...config,
    ...overrides,
    enabled: {
      ...DEFAULTS.enabled,
      ...(config.enabled || {}),
      ...(overrides.enabled || {})
    }
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
  // Start it first so config/overrides are loaded before the CEO check.
  if (!state.running) startAutopilot({});
  const denial = requireCeo('fleet rally');
  if (denial) return denial;
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
  const denial = requireCeo('rally step');
  if (denial) return denial;
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

// Task slots are shared across every corp member, so any command that touches
// a non-primary ship must be CEO-gated — otherwise two players' autopilots
// trample each other's dispatches. When the flag isn't set we refuse the op
// outright rather than silently no-op, so the UI can surface the reason.
const requireCeo = (label) => {
  if (state.config?.isCeo) return null;
  return { ok: false, error: `${label} requires CEO mode — non-CEO autopilots must not command corp ships` };
};

// Shared precondition for one-shot credit sequences — transfer_credits
// silently fails at the game layer unless both ships share a sector, so we
// refuse to queue the sequence when the primary isn't docked and idle.
const assertPrimaryReady = (primary, label) => {
  if (primary == null || primary.sector == null) {
    return { ok: false, error: `primary ship sector unknown — dock the primary before running ${label}` };
  }
  if (primary.active === true) {
    return { ok: false, error: `primary ship is mid-task — wait for it to dock before running ${label}` };
  }
  return { ok: true };
};

const coLocationReason = (ship, primarySector) => {
  if (ship.sector === primarySector) return null;
  return ship.sector == null ? 'sector unknown' : `at sector ${ship.sector}, primary at ${primarySector}`;
};

const logSkipped = (key, skipped) => {
  if (!skipped.length) return;
  appendLog({
    type: 'decision',
    key,
    ship: FLEET_PLAN_KEY,
    text: `skipping non-co-located ships: ${skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}`
  });
};

/**
 * Fund each corp ship as a separate primary-ship action. One bank_withdraw
 * up front, then one transfer_credits per underfunded ship.
 */
export const queueFundSequence = async () => {
  const denial = requireCeo('fund sequence');
  if (denial) return denial;
  if (queueRunning['fund-seq']) return { ok: false, error: 'fund sequence already running' };
  const snap = await freshSnapshot();
  const ships = snap?.extracted?.ships || [];
  if (ships.length === 0) return { ok: false, error: 'no ships in snapshot — is CDP connected?' };
  const primary = ships.find((s) => s.primary);
  const primaryName = primary?.name || 'the primary ship';
  const ready = assertPrimaryReady(primary, 'fund sequence');
  if (!ready.ok) return ready;
  const onHand = snap.extracted.creditsOnHand ?? 0;
  const keepFloor = state.config?.onHandFloor ?? 1000;

  const transfers = [];
  const skipped = [];
  for (const s of ships) {
    if (s.primary) continue;
    const needs = (s.credits != null && s.credits < 1000) || s.credits == null;
    if (!needs) continue;
    const reason = coLocationReason(s, primary.sector);
    if (reason) { skipped.push({ name: s.name, reason }); continue; }
    const amount = s.credits == null ? 1000 : 1000 - s.credits;
    transfers.push({ name: s.name, amount });
  }
  if (transfers.length === 0) {
    return { ok: true, queued: 0, note: skipped.length ? 'no co-located corp ships need funding' : 'no corp ships need funding', skipped };
  }

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
  logSkipped('fund-seq', skipped);

  return {
    ok: true,
    step: 'fund-for-recharge',
    queued: prompts.length,
    totalTransfer,
    withdrawNeeded,
    transfers,
    skipped
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
  const denial = requireCeo('balance sequence');
  if (denial) return denial;
  if (queueRunning['balance-seq']) return { ok: false, error: 'balance sequence already running' };
  const snap = await freshSnapshot();
  const ships = snap?.extracted?.ships || [];
  if (ships.length === 0) return { ok: false, error: 'no ships in snapshot — is CDP connected?' };
  const primary = ships.find((s) => s.primary);
  const primaryName = primary?.name || 'the primary ship';
  const ready = assertPrimaryReady(primary, 'balance sequence');
  if (!ready.ok) return ready;
  const onHand = snap.extracted.creditsOnHand ?? 0;
  const keepCredits = state.config?.onHandFloor ?? 1000;

  const sweeps = [];
  const topUps = [];
  const unknowns = [];
  const skipped = [];
  for (const s of ships) {
    if (s.primary) continue;
    if (s.credits == null) { unknowns.push(s.name); continue; }
    const reason = coLocationReason(s, primary.sector);
    if (reason) { skipped.push({ name: s.name, reason }); continue; }
    if (s.credits > keepCredits) sweeps.push({ name: s.name, amount: s.credits - keepCredits });
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
  logSkipped('balance-seq', skipped);

  if (prompts.length === 0) return { ok: true, queued: 0, note: 'no co-located corp ships need balancing', skipped };

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
    unknowns,
    skipped
  };
};

export const subscribeAutopilotLog = (fn) => {
  state.subscribers.add(fn);
  return () => state.subscribers.delete(fn);
};
