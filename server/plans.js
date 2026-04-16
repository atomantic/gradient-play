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

const isProbe = (ship) => /PROBE/i.test(ship.name || '');

/**
 * Refuel plan for a ship that fell below warp floor.
 * Steps:
 *   1. route-to-megaport — break off task, dock at nearest megaport
 *   2. fund-ship         — (only if ship.credits < creditsForRefuel) transfer
 *                          from primary/bank so it can afford recharge
 *   3. recharge-warp     — top up warp
 *   4. resume            — put ship back on its role-appropriate task
 */
export const buildRefuelPlan = (ship, { creditsForRefuel = 1000 } = {}) => {
  const shipCredits = ship.credits ?? 0;
  const needsCredits = shipCredits < creditsForRefuel;
  const initialWarp = ship.warpPower ?? 0;
  const maxWarp = warpMaxOf(ship);
  const steps = [];

  steps.push({
    name: 'route-to-megaport',
    prompt: `${ship.name} is low on warp. break it off any active task and route to the nearest megaport. just dock — no trading on the way.`,
    nagMs: 120_000,
    maxMs: 7 * 60_000,
    // Heuristic: the ship is idle and its warp has stopped decreasing for one
    // tick (no movement in-flight). Tracked via context.lastWarp.
    isDone: (_snap, s, p) => {
      const prev = p.context.lastWarp;
      p.context.lastWarp = s.warpPower;
      if (s.active !== false) return false;
      if (prev == null) return false;
      // Docked + no movement between two successive ticks.
      return s.warpPower === prev;
    }
  });

  if (needsCredits) {
    steps.push({
      name: 'fund-ship',
      // transfer_credits requires both ships to be docked at the same megaport.
      // If the primary is elsewhere, bring it to ${ship}'s port (or vice versa)
      // before the transfer. If the primary is low on on-hand, it withdraws
      // from bank first (bank_withdraw requires being docked too).
      prompt: `${ship.name} is docked but broke. bring the primary ship to ${ship.name}'s megaport (they must be at the same port for transfer_credits to work). primary withdraws from bank if needed, then transfers ${creditsForRefuel} credits to ${ship.name}. no new autonomous task — do this inline.`,
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
      : `${ship.name} is fueled. resume a short fedspace NS trade loop, 2-3 hops.`,
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

// ── Fleet-wide rally plan ────────────────────────────────────────────
// Sentinel key: plans.set('__fleet__', plan). processPlans detects this
// and passes ship=null to isDone (steps use the full snapshot instead).

export const FLEET_PLAN_KEY = '__fleet__';

const MIN_WARP_TO_MOVE = 20;

/**
 * Rally, refuel, bank — in order:
 *   1. fuel-share  → ships with spare warp help stranded ones (transfer_warp_power)
 *   2. rally       → every ship routes to the nearest shared safe megaport
 *   3. recharge    → recharge_warp_power on every ship
 *   4. credit-sweep → transfer excess credits to primary, primary bank_deposits
 *   5. resume      → put every ship back on its role-appropriate task
 */
export const buildFleetRallyPlan = (ships = [], { keepCredits = 1000, megaports = [305, 472, 1413], homeHub = 305, resume = true } = {}) => {
  const names = ships.map((s) => s.name).filter(Boolean);
  const fleetLabel = names.length ? names.join(', ') : 'every ship';
  const primary = ships.find((s) => s.primary);
  const primaryName = primary?.name || 'the primary ship';

  const steps = [];

  // Step 1: fuel-share
  steps.push({
    name: 'fuel-share',
    prompt: `fuel share. check EVERY ship (${fleetLabel}), including the primary ${primaryName}. any ship with warp < ${MIN_WARP_TO_MOVE} is stranded. for each stranded ship, find the nearest fleetmate with spare warp and use transfer_warp_power to give it at least ${MIN_WARP_TO_MOVE * 3} warp so it can reach a megaport. do this interactively — do NOT start autonomous tasks.`,
    nagMs: 120_000,
    maxMs: 6 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
      return all.every((s) => s.warpPower == null || s.warpPower >= MIN_WARP_TO_MOVE);
    }
  });

  // Step 2: rally — everyone MUST meet at the home hub specifically, not
  // just any shared sector. This guarantees transfer_credits/bank_deposit
  // coordination later.
  steps.push({
    name: 'rally',
    prompt: `converge at home hub ${homeHub}. route EVERY ship to sector ${homeHub} and dock — this includes the primary ${primaryName}, do NOT skip it. full fleet: ${fleetLabel}. call plot_course directly for each ship (interactive). do NOT use start_task — no trade/explore tasks, just move every ship to ${homeHub} and dock.`,
    nagMs: 150_000,
    maxMs: 8 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
      if (all.length < 2) return false;
      return all.every((s) => s.sector === homeHub && s.active === false);
    }
  });

  // Step 3: fund ships for recharge
  // The game assistant can't query corp-ship credits directly — it only sees
  // its own context. We scraped the balances from the DOM, so we bake the
  // per-ship transfer amounts into the prompt.
  const corpShips = ships.filter((s) => !s.primary);
  const fundNeeded = corpShips
    .filter((s) => s.credits != null && s.credits < 1000)
    .map((s) => `${s.name}: has ${s.credits}, transfer ${1000 - s.credits}`);
  const fundUnknown = corpShips.filter((s) => s.credits == null).map((s) => s.name);
  const fundLines = [];
  if (fundNeeded.length) fundLines.push(fundNeeded.join('; '));
  if (fundUnknown.length) fundLines.push(`unknown balances (top up to 1000 blindly, we'll sweep back later): ${fundUnknown.join(', ')}`);
  const fundBody = fundLines.length
    ? fundLines.join('. ')
    : 'all corp ships already have ≥ 1000 credits — nothing to do';
  steps.push({
    name: 'fund-for-recharge',
    prompt: `fund ships. ${primaryName} is at hub ${homeHub} with the corp ships. ${fundBody}. ${primaryName} withdraws from bank first if on-hand is short. use transfer_credits for each. interactive only — no new tasks.`,
    nagMs: 90_000,
    maxMs: 4 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
      return all.filter((s) => !s.primary).every((s) => s.credits == null || s.credits >= 800);
    }
  });

  // Step 4: recharge
  steps.push({
    name: 'recharge',
    prompt: `recharge. all ships are funded and docked at ${homeHub}. recharge_warp_power on every ship to full, including the primary ${primaryName}. full fleet: ${fleetLabel}. do this interactively for each one.`,
    nagMs: 90_000,
    maxMs: 5 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
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
  const balanceLines = corpShips.map((s) => {
    if (s.credits == null) return `${s.name}: balance unknown — ask it to report credits, then top-up or sweep to ${keepCredits}`;
    const diff = s.credits - keepCredits;
    if (diff > 0) return `${s.name}: has ${s.credits}, transfer ${diff} to ${primaryName}`;
    if (diff < 0) return `${s.name}: has ${s.credits}, ${primaryName} transfers ${-diff} to it`;
    return `${s.name}: already at ${keepCredits}`;
  });
  steps.push({
    name: 'credit-balance',
    prompt: `balance credits at ${keepCredits} each. everyone is docked at hub ${homeHub}. ${balanceLines.join('; ')}. ${primaryName} withdraws from bank if on-hand too low for the top-ups. once every corp ship is at ${keepCredits}, ${primaryName} bank_deposits everything above its own ${keepCredits} float. interactive only — no new tasks.`,
    nagMs: 90_000,
    maxMs: 4 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
      const corpShips = all.filter((s) => !s.primary && s.credits != null);
      return corpShips.every((s) => {
        // Allow a small tolerance band around keepCredits — recharge costs
        // between transfer and isDone may leave ships slightly off.
        return s.credits >= keepCredits - 100 && s.credits <= keepCredits + 200;
      });
    }
  });

  // Step 6: resume (optional — skip for "Home Base" which parks the fleet)
  if (resume) steps.push({
    name: 'resume',
    prompt: `dispatch roles. put each ship back on its role-appropriate task. haulers on short fedspace NS trade loops, probes on explore/salvage (or their named role — refueler stays parked, explorer maps, scavenger salvages). primary on a fedspace trade loop.`,
    nagMs: 120_000,
    maxMs: 5 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
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
