/**
 * Multi-step plans. One active plan per ship. Each step has:
 *   name       — short label ("route-to-megaport", "fund-ship", ...)
 *   prompt     — text sent to the assistant when the step becomes active or nags
 *   nagMs      — if the step isn't done after this long since the last prompt,
 *                re-send the same prompt
 *   maxMs      — hard timeout. If exceeded without isDone returning true, we
 *                advance anyway and log a timeout
 *   isDone     — (snap, ship, plan) => boolean. Pure: reads snapshot and the
 *                plan's own context map. Returning true advances the plan.
 *
 * Completion heuristics lean on DOM snapshot fields that are always present
 * (ship.warpPower, ship.active, ship.credits, ship.sector). Chat parsing is
 * too fragile for this layer — plans advance on observable state.
 */

const now = () => Date.now();

export const newPlan = ({ ship, goal, steps, context = {} }) => ({
  id: `${ship}:${goal}:${now()}`,
  ship,
  goal,
  steps,
  context,
  currentStep: 0,
  createdAt: now(),
  updatedAt: now(),
  stepStartedAt: now(),
  lastPromptedAt: 0,
  promptCount: 0,
  history: []
});

export const currentStepOf = (plan) => plan.steps[plan.currentStep];
export const isComplete = (plan) => plan.currentStep >= plan.steps.length;

export const advance = (plan, reason = 'done') => {
  plan.history.push({
    stepIndex: plan.currentStep,
    stepName: plan.steps[plan.currentStep]?.name,
    reason,
    at: now()
  });
  plan.currentStep += 1;
  plan.stepStartedAt = now();
  plan.lastPromptedAt = 0;
  plan.promptCount = 0;
  plan.updatedAt = now();
};

// Corp ships don't render cur/max warp in their ShipCard, so we can't read
// warpMax from DOM. Default by class.
const warpMaxOf = (ship) => {
  if (ship.warpMax != null) return ship.warpMax;
  const n = (ship.name || '').toUpperCase();
  if (/PROBE/.test(n)) return 500;
  if (/HAULER|FREIGHTER|LIFTER|ATLAS|PIONEER|WAYFARER/.test(n)) return 500;
  if (/KESTREL|SPARROW|COURIER/.test(n)) return 300;
  return 500;
};

// Mirrors autopilot.js shipKind() — any corp ship named as a probe-class
// scout. Refueler/tanker ships are intentionally NOT in this set; they still
// participate in fleet rally (their job is to come home and refuel others).
const isProbe = (ship) => /PROBE|EXPLORER|SCAVENGER|SALVAGER|SCOUT|PATHFINDER/i.test(ship.name || '');

/**
 * Refuel plan for a ship that fell below warp floor.
 * Steps:
 *   1. route-to-megaport — break off task, dock at nearest megaport
 *   2. fund-ship         — (only if ship.credits < creditsForRefuel) transfer
 *                          from primary/bank so it can afford recharge
 *   3. recharge-warp     — top up warp
 *   4. resume            — put ship back on its role-appropriate task
 */
export const buildRefuelPlan = (ship, { creditsForRefuel = 1000, megaports = [], homeHub = 305 } = {}) => {
  const shipCredits = ship.credits ?? 0;
  const needsCredits = shipCredits < creditsForRefuel;
  const initialWarp = ship.warpPower ?? 0;
  const maxWarp = warpMaxOf(ship);
  const megaportSet = new Set(megaports);
  const steps = [];

  steps.push({
    name: 'route-to-megaport',
    // Route explicitly to the home hub. "Nearest megaport" drifted to
    // whichever port the agent considered nearest — sometimes landing the
    // ship at a standard (non-mega) port like 1333, where recharge and
    // primary↔corp credit transfers both fail. Home hub is guaranteed to
    // be a real megaport (validated against config.megaports at Start).
    prompt: `send ${ship.name} to sector ${homeHub} (home megaport) to refuel.`,
    nagMs: 120_000,
    maxMs: 7 * 60_000,
    isDone: (_snap, s, p) => {
      // Already parked at a known megaport? Skip the routing step — the
      // pre-advance loop runs this at plan creation time so we also skip
      // the prompt entirely when we catch the ship already docked at a hub.
      if (s.sector != null && megaportSet.has(s.sector)) return true;
      // Early exit: if the ship is already at full warp (e.g. user manually
      // refueled, or another flow handled it), the refuel plan is moot —
      // advance through the rest of the plan to the resume step. Prevents
      // "send hauler to megaport to refuel" firing at a full-fuel ship.
      const cap = s.warpMax ?? warpMaxOf(s);
      if (s.warpPower != null && s.warpPower >= cap * 0.9) return true;
      // NOTE: do NOT accept "docked at any port with no movement" as done.
      // Earlier heuristics did, which let the plan advance at a standard
      // (non-mega) port — then the fund-ship / recharge-warp steps fired
      // at a port that accepts neither operation. Require a megaport match.
      p.context.lastWarp = s.warpPower;
      return false;
    }
  });

  if (needsCredits) {
    steps.push({
      name: 'fund-ship',
      // transfer_credits requires both ships to be docked at the same
      // megaport. The primary typically lives at the home hub, so we
      // coordinate the rendezvous there instead of asking the primary to
      // chase the broke ship across the map.
      prompt: `${ship.name} is at sector ${homeHub} (home megaport) but broke. primary ship should also dock at sector ${homeHub} (route there if not already), bank_withdraw if on-hand is low, then transfer_credits ${creditsForRefuel} to ${ship.name}. no new autonomous task — do this inline.`,
      nagMs: 90_000,
      maxMs: 4 * 60_000,
      isDone: (_snap, s) => (s.credits ?? 0) >= creditsForRefuel
    });
  }

  steps.push({
    name: 'recharge-warp',
    prompt: `recharge ${ship.name}'s warp to full at its current megaport.`,
    nagMs: 90_000,
    maxMs: 3 * 60_000,
    // "Full" is ≥90% of class max. Corp ships don't render warpMax, so we
    // use the class default.
    isDone: (_snap, s) => {
      const cap = s.warpMax ?? warpMaxOf(s);
      return s.warpPower != null && s.warpPower >= cap * 0.9;
    }
  });

  steps.push({
    name: 'resume',
    prompt: isProbe(ship)
      ? `${ship.name} is fueled. resume exploration/salvage — 40 hop radius, flee combat, deposit credits at megaports.`
      : `${ship.name} is fueled. resume trading in fedspace, route is your call.`,
    nagMs: 120_000,
    maxMs: 3 * 60_000,
    isDone: (_snap, s) => s.active === true
  });

  return newPlan({
    ship: ship.name,
    goal: 'refuel',
    steps,
    context: { initialWarp, maxWarp, creditsForRefuel, needsCredits }
  });
};

/**
 * Fuel-delivery plan: any probe (donor) travels to a low-fuel ship and
 * transfer_warp_powers a top-up. Donor is picked server-side by proximity
 * (see autopilot pickDonor). Keyed by the donor so decide() won't send it
 * elsewhere mid-delivery. Target is in context.blockedShips so the fuel
 * guard doesn't re-fire on it while this plan is live.
 */
export const buildRefuelerRescuePlan = (target, donor, { transferAmt = 300 } = {}) => {
  const targetName = target.name;
  const donorName = donor.name;
  const targetSector = target.sector;
  // Only include the sector hint when we actually know it — if the DOM
  // scrape couldn't read the primary's sector, the agent can resolve the
  // location itself (corporation_info / my_status). Baking "@null" into
  // the prompt was causing the agent to refuse the command and ask us
  // where the ship is.
  const locHint = targetSector != null ? ` @${targetSector}` : '';

  const steps = [{
    name: 'fuel-delivery',
    prompt: `${donorName}: refuel ${targetName}${locHint} — plot_course, transfer_warp_power ${transferAmt}. execute now.`,
    nagMs: 90_000,
    maxMs: 10 * 60_000,
    isDone: (snap, _ship, plan) => {
      const byName = snap?.extracted?.ships || [];
      const t = byName.find((s) => s.name === targetName);
      const d = byName.find((s) => s.name === donorName);
      // Donor is out of warp — whatever it had is spent (either on the
      // plot_course leg or an already-completed transfer). No point nagging
      // a transfer_warp_power it can't fulfil; end the plan and let the
      // regular scrap loop recycle the empty probe.
      if (d && d.warpPower != null && d.warpPower <= 10) return true;
      if (!t || t.warpPower == null) return false;
      const baseline = plan.context.targetWarpBefore ?? 0;
      return t.warpPower >= baseline + Math.floor(transferAmt * 0.5);
    }
  }];

  return newPlan({
    ship: donorName,
    goal: 'fuel-delivery',
    steps,
    context: {
      target: targetName,
      donor: donorName,
      transferAmt,
      targetWarpBefore: target.warpPower ?? 0,
      blockedShips: [targetName]
    }
  });
};

/**
 * Probe-replacement plan: the primary decommissions a dead probe and
 * activates a reserve (or buys a new hull) as its replacement. sell_ship
 * only works from a megaport, so step 1 routes the primary there first —
 * formerly this was a single sub-clause in a one-shot prompt and the agent
 * sometimes tried to sell before docking. The route step auto-skips when
 * the primary is already at a megaport.
 */
export const buildProbeReplacementPlan = (deadProbe, {
  primary,
  hubSector = 1413,
  megaports = [305, 472, 1413],
  reserveName = null,
  frontierSector = null
} = {}) => {
  const megaportSet = new Set(megaports);
  const primaryName = primary.name;
  const steps = [];

  steps.push({
    name: 'route-primary-to-hub',
    prompt: `${primaryName}: plot_course to sector ${hubSector} (megaport) and dock — sell_ship requires a megaport. interrupt trade if needed. one action, execute immediately, no confirmation.`,
    nagMs: 120_000,
    maxMs: 8 * 60_000,
    isDone: (snap) => {
      const p = (snap?.extracted?.ships || []).find((s) => s.name === primaryName);
      return !!(p && p.sector != null && megaportSet.has(p.sector) && p.active === false);
    }
  });

  const activationStep = reserveName
    ? `rename "${reserveName}" to a short name`
    : `ship_purchase Autonomous Probe and give it a short name (no date suffix)`;
  const startClause = frontierSector != null
    ? `starting at sector ${frontierSector}`
    : `starting at the nearest known-unvisited sector`;
  const fetchIds = reserveName
    ? `ship_ids for "${deadProbe.name}" and "${reserveName}"`
    : `ship_id for "${deadProbe.name}"`;

  steps.push({
    name: 'decommission',
    prompt: `decommission ${deadProbe.name}. sequence: 1) corporation_info → ${fetchIds}, 2) sell_ship ${deadProbe.name}, 3) ${activationStep}, 4) start_task on the new/renamed probe: explore until dry, ${startClause}. at each sector widen local_map_region until a KNOWN-UNVISITED hex appears and plot_course there; never halt while any known-unvisited sector remains; never return to refuel. one action at a time, execute immediately, no confirmation.`,
    nagMs: 90_000,
    maxMs: 8 * 60_000,
    isDone: (snap) => {
      const stillThere = (snap?.extracted?.ships || []).some((s) => s.name === deadProbe.name);
      return !stillThere;
    }
  });

  return newPlan({
    ship: primaryName,
    goal: 'probe-replace',
    steps,
    context: { deadProbe: deadProbe.name, reserveName, blockedShips: [deadProbe.name] }
  });
};

// ── Fleet-wide rally plan ────────────────────────────────────────────
// Sentinel key: plans.set('__fleet__', plan). processPlans detects this
// and passes ship=null to isDone (steps use the full snapshot instead).

export const FLEET_PLAN_KEY = '__fleet__';

const MIN_WARP_TO_MOVE = 20;

// Append to every rally-step prompt. The game assistant defaults to
// "ready to... on your order, commander" politeness; this tells it to
// just execute.
const EXEC_NOW = ' execute immediately, no confirmation needed.';

/**
 * Rally, refuel, bank — in order:
 *   1. fuel-share  → ships with spare warp help stranded ones (transfer_warp_power)
 *   2. rally       → every ship routes to the nearest shared safe megaport
 *   3. recharge    → recharge_warp_power on every ship
 *   4. credit-sweep → transfer excess credits to primary, primary bank_deposits
 *   5. resume      → put every ship back on its role-appropriate task
 *
 * Probes (explorer/scavenger/salvager/scout/pathfinder) are intentionally
 * EXCLUDED from every operational step. They're designed to run dry in the
 * field — recalling them wastes exploration progress and they're reclaimed
 * later via the sell+rebuy workflow when the primary docks. Refuelers stay
 * in the rally (they come home to refuel the fleet, that's their role).
 */
export const buildFleetRallyPlan = (ships = [], { keepCredits = 1000, megaports = [305, 472, 1413], homeHub = 305, resume = true } = {}) => {
  const opShips = ships.filter((s) => !isProbe(s));
  const names = opShips.map((s) => s.name).filter(Boolean);
  const fleetLabel = names.length ? names.join(', ') : 'every non-probe ship';
  const primary = opShips.find((s) => s.primary) || ships.find((s) => s.primary);
  const primaryName = primary?.name || 'the primary ship';

  const steps = [];

  // Step 1: fuel-share. Donors are probes only — never the primary or any
  // hauler. If no probe has spare warp, skip this step and move to rally.
  steps.push({
    name: 'fuel-share',
    prompt: `transfer_warp_power from any probe with spare warp to any non-probe ship with warp < ${MIN_WARP_TO_MOVE}, enough to reach ≥ ${MIN_WARP_TO_MOVE * 3}. fleet: ${fleetLabel}. donors must be probes (never the primary, never a hauler). no new tasks.${EXEC_NOW}`,
    nagMs: 120_000,
    maxMs: 6 * 60_000,
    isDone: (snap) => {
      const all = (snap?.extracted?.ships || []).filter((s) => !isProbe(s));
      return all.every((s) => s.warpPower == null || s.warpPower >= MIN_WARP_TO_MOVE);
    }
  });

  // Step 2: rally — every non-probe ship meets at the home hub. Probes stay
  // in the field; they're reclaimed via remote sell+rebuy, not by recall.
  steps.push({
    name: 'rally',
    prompt: `plot_course every ship to sector ${homeHub} and dock. fleet: ${fleetLabel}. do NOT recall probes — leave any probe/explorer/scavenger/salvager alone in the field. no start_task.${EXEC_NOW}`,
    nagMs: 150_000,
    maxMs: 8 * 60_000,
    isDone: (snap) => {
      const all = (snap?.extracted?.ships || []).filter((s) => !isProbe(s));
      if (all.length < 2) return false;
      return all.every((s) => s.sector === homeHub && s.active === false);
    }
  });

  // Step 3: fund ships for recharge
  // The game assistant can't query corp-ship credits directly — it only sees
  // its own context. We scraped the balances from the DOM, so we bake the
  // per-ship transfer amounts and the total-to-withdraw into the prompt.
  // Game mechanic: each transfer_credits is a separate action by the primary,
  // so the agent must queue them one at a time; but one bank_withdraw covers
  // the whole batch.
  const corpShips = opShips.filter((s) => !s.primary);
  const fundTransfers = corpShips
    .filter((s) => s.credits != null && s.credits < 1000)
    .map((s) => ({ name: s.name, amount: 1000 - s.credits }));
  const fundUnknown = corpShips.filter((s) => s.credits == null).map((s) => s.name);
  for (const name of fundUnknown) fundTransfers.push({ name, amount: 1000 });
  const fundTotal = fundTransfers.reduce((sum, t) => sum + t.amount, 0);
  const fundSequence = fundTransfers.map((t, i) => `${i + 1}) transfer_credits ${t.amount} to ${t.name}`).join('; ');
  const fundAlreadyOk = corpShips.filter((s) => s.credits != null && s.credits >= 1000).map((s) => s.name);
  const fundBody = fundTransfers.length
    ? `total to cover: ${fundTotal} credits. step A: ONE bank_withdraw of ${fundTotal} (or more, primary can re-deposit extra later). step B: queue these transfers in order, ONE AT A TIME — each transfer_credits is a separate primary-ship action, wait for the previous to complete before firing the next: ${fundSequence}. PARALLELISM: any corp ship that already has enough credits can start recharge_warp_power immediately (up to 3 corp ships can run actions at once); don't wait for primary to finish. ${fundAlreadyOk.length ? `already funded and can recharge in parallel: ${fundAlreadyOk.join(', ')}` : ''} after a ship receives its transfer, it should also start recharge_warp_power without waiting`
    : 'all corp ships already have ≥ 1000 credits — nothing to do';
  steps.push({
    name: 'fund-for-recharge',
    prompt: `fund ships. ${fundBody}. no new tasks.${EXEC_NOW}`,
    nagMs: 90_000,
    maxMs: 4 * 60_000,
    isDone: (snap) => {
      const all = (snap?.extracted?.ships || []).filter((s) => !isProbe(s));
      return all.filter((s) => !s.primary).every((s) => s.credits == null || s.credits >= 800);
    }
  });

  // Step 4: recharge — only name ships that actually need it. Ships already
  // at ≥90% of class max are skipped so the agent doesn't waste an action
  // (and credits) topping off a full tank.
  const rechargeNeeded = opShips.filter((s) => {
    if (s.warpPower == null) return true; // unknown — include to be safe
    const max = s.warpMax ?? warpMaxOf(s);
    return s.warpPower < max * 0.9;
  });
  const rechargeFull = opShips
    .filter((s) => s.warpPower != null && s.warpPower >= (s.warpMax ?? warpMaxOf(s)) * 0.9)
    .map((s) => s.name);
  const rechargeNames = rechargeNeeded.map((s) => s.name).filter(Boolean);
  const rechargeBody = rechargeNames.length
    ? `recharge_warp_power to full on: ${rechargeNames.join(', ')}. up to 3 in parallel.${rechargeFull.length ? ` already full, SKIP: ${rechargeFull.join(', ')}.` : ''}`
    : 'all ships already at full warp — nothing to recharge, no actions needed';
  steps.push({
    name: 'recharge',
    prompt: `${rechargeBody}${EXEC_NOW}`,
    nagMs: 90_000,
    maxMs: 5 * 60_000,
    isDone: (snap) => {
      const all = (snap?.extracted?.ships || []).filter((s) => !isProbe(s));
      return all.every((s) => {
        if (s.warpPower == null) return true;
        const max = s.warpMax ?? warpMaxOf(s);
        return s.warpPower >= max * 0.9;
      });
    }
  });

  // Step 5: credit balance
  // Every corp ship should end with exactly ${keepCredits} on hand — top up
  // from primary if below, sweep excess to primary if above. Primary banks
  // everything above its own ${keepCredits} float. Uniform policy: all ships
  // get the same working capital. Balances baked in because the assistant
  // can't query them directly.
  const sweepsToPrimary = [];   // corp → primary (corp-ship actions, parallelizable up to 3)
  const topUpsFromPrimary = []; // primary → corp (primary-ship actions, sequential)
  const balanceUnknown = [];
  for (const s of corpShips) {
    if (s.credits == null) balanceUnknown.push(s.name);
    else if (s.credits > keepCredits) sweepsToPrimary.push({ name: s.name, amount: s.credits - keepCredits });
    else if (s.credits < keepCredits) topUpsFromPrimary.push({ name: s.name, amount: keepCredits - s.credits });
  }
  const sweepSeq = sweepsToPrimary.map((t, i) => `${i + 1}) ${t.name} transfer_credits ${t.amount} to ${primaryName}`).join('; ');
  const topUpSeq = topUpsFromPrimary.map((t, i) => `${i + 1}) transfer_credits ${t.amount} to ${t.name}`).join('; ');
  const balanceParts = [];
  if (sweepsToPrimary.length) balanceParts.push(`PHASE 1 (corp ships sweep excess to primary — these are corp-ship actions, up to 3 can run in parallel): ${sweepSeq}`);
  if (topUpsFromPrimary.length) balanceParts.push(`PHASE 2 (primary tops up low ships — these are primary-ship actions, queue ONE AT A TIME, wait for each to complete): ${topUpSeq}`);
  if (balanceUnknown.length) balanceParts.push(`unknown balances: ${balanceUnknown.join(', ')} — ask each to report credits, then sweep or top up to ${keepCredits}`);
  balanceParts.push(`PHASE 3 (primary bank_deposits everything above its own ${keepCredits} float)`);
  steps.push({
    name: 'credit-balance',
    prompt: `balance credits at ${keepCredits} each. ${balanceParts.join('. ')}. no new tasks.${EXEC_NOW}`,
    nagMs: 90_000,
    maxMs: 4 * 60_000,
    isDone: (snap) => {
      const all = (snap?.extracted?.ships || []).filter((s) => !isProbe(s));
      const corpShips = all.filter((s) => !s.primary && s.credits != null);
      return corpShips.every((s) => {
        // Allow a small tolerance band around keepCredits — recharge costs
        // between transfer and isDone may leave ships slightly off.
        return s.credits >= keepCredits - 100 && s.credits <= keepCredits + 200;
      });
    }
  });

  // Step 6: resume (optional — skip for "Home Base" which parks the fleet).
  // Probes in the field keep doing whatever they were doing; we only dispatch
  // the ships that came home to rally.
  if (resume) steps.push({
    name: 'resume',
    prompt: `dispatch non-probe ships: haulers/primary trade in fedspace, routes are their call. refueler: park. leave any probe/explorer/scavenger alone — they stay on their current task in the field.${EXEC_NOW}`,
    nagMs: 120_000,
    maxMs: 5 * 60_000,
    isDone: (snap) => {
      const all = (snap?.extracted?.ships || []).filter((s) => !isProbe(s));
      return all.filter((s) => !s.primary).every((s) => s.active === true);
    }
  });

  return newPlan({
    ship: FLEET_PLAN_KEY,
    goal: 'rally',
    steps,
    context: { keepCredits, shipCount: names.length }
  });
};
