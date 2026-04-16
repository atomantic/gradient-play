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
export const buildFleetRallyPlan = (ships = [], { keepCredits = 1000, megaports = [305, 472, 1413] } = {}) => {
  const names = ships.map((s) => s.name).filter(Boolean);
  const fleetLabel = names.length ? names.join(', ') : 'every ship';

  const steps = [];

  // Step 1: fuel-share
  steps.push({
    name: 'fuel-share',
    prompt: `fleet rally step 1 — fuel share. check all corp ships (${fleetLabel}). any ship with warp < ${MIN_WARP_TO_MOVE} is stranded. for each stranded ship, find the nearest corpmate with spare warp and use transfer_warp_power to give it at least ${MIN_WARP_TO_MOVE * 3} warp so it can reach a megaport. do this interactively — do NOT start autonomous tasks.`,
    nagMs: 120_000,
    maxMs: 6 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
      return all.every((s) => s.warpPower == null || s.warpPower >= MIN_WARP_TO_MOVE);
    }
  });

  // Step 2: rally
  steps.push({
    name: 'rally',
    prompt: `fleet rally step 2 — converge. route ALL ships (${fleetLabel}) to the nearest mega-port (${megaports.join('/')} — pick whichever most of the fleet can reach cheaply). use plot_course for each. don't start trade or explore tasks — just move everyone to the SAME megaport and dock.`,
    nagMs: 150_000,
    maxMs: 8 * 60_000,
    // "Everyone docked at the same sector" is hard to verify from DOM alone
    // (we don't know megaport sector IDs). Heuristic: all non-primary ships
    // are idle and share a sector with the primary.
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
      if (all.length < 2) return false;
      const primary = all.find((s) => s.primary);
      if (!primary?.sector) return false;
      return all.every((s) => s.sector === primary.sector && s.active === false);
    }
  });

  // Step 3: fund ships for recharge
  // Recharging warp costs credits. Ships that are broke need a credit transfer
  // from the primary before they can recharge. Since everyone is docked at the
  // same megaport, transfer_credits works directly.
  steps.push({
    name: 'fund-for-recharge',
    prompt: `fleet rally step 3 — fund ships. all ships are at the same megaport. check each corp ship's credits. if any ship has < 1000 credits, have the primary withdraw from bank (if needed) and transfer_credits 1000 to that ship so it can afford recharge_warp_power. interactive only — no new tasks.`,
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
    prompt: `fleet rally step 4 — recharge. all ships are funded and docked. recharge_warp_power on every ship (${fleetLabel}) to full. do this interactively for each one.`,
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

  // Step 5: credit sweep
  // Probes don't trade — they have no use for credits after refueling, so they
  // sweep their balance to ZERO. Haulers and other trade ships keep a working
  // float so they can buy/sell on their next loop.
  steps.push({
    name: 'credit-sweep',
    prompt: `fleet rally step 5 — bank all credits. everyone is docked together. for each PROBE, transfer_credits ALL credits (down to 0) to the primary — probes don't trade, they don't need a float. for each HAULER / other ship, transfer everything above ${keepCredits}. once the primary has collected all excess, bank_deposit everything above ${keepCredits}. interactive only.`,
    nagMs: 90_000,
    maxMs: 4 * 60_000,
    isDone: (snap) => {
      const all = snap?.extracted?.ships || [];
      const corpShips = all.filter((s) => !s.primary && s.credits != null);
      return corpShips.every((s) => {
        const isP = /PROBE/i.test(s.name || '');
        return isP ? s.credits <= 50 : s.credits <= keepCredits + 200;
      });
    }
  });

  // Step 6: resume
  steps.push({
    name: 'resume',
    prompt: `fleet rally complete — all ships fueled, credits banked. resume normal operations: put each ship back on its role-appropriate task. haulers on short fedspace NS trade loops, probes on explore/salvage (or their named role — refueler stays parked, explorer maps, scavenger salvages). primary on a fedspace trade loop.`,
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
