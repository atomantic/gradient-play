import { randomUUID } from 'node:crypto';
import { getGameSnapshot, sendAssistantPrompt, getMapSectors, verifyDispatch } from './cdp.js';
import { findNearestFrontier } from './autopilot.js';
import { pick } from './utils.js';

// Placeholder that missions can embed in their goal to get the server-side
// frontier BFS (same logic autopilot uses for probe dispatch) interpolated in
// at kickoff time. User can override via spec.startSector.
const STARTING_SECTOR_TOKEN = /\{\{\s*startSector\s*\}\}/g;

/**
 * Resolve a concrete starting sector for an exploration-style mission.
 *   - spec.startSector (number) → user override wins.
 *   - Otherwise, if the goal contains {{startSector}}, walk the React fiber's
 *     known-sector map via getMapSectors and pick the nearest unvisited
 *     frontier (same BFS the autopilot uses for probe dispatch).
 *   - If nothing's reachable (no map, no unvisited neighbours) return null so
 *     the caller can swap in a "pick one nearby" fallback string.
 */
const resolveStartSector = async (spec) => {
  if (spec.startSector != null && Number.isFinite(Number(spec.startSector))) {
    return { sector: Number(spec.startSector), source: 'user-override' };
  }
  if (!STARTING_SECTOR_TOKEN.test(spec.goal || '')) return { sector: null };
  STARTING_SECTOR_TOKEN.lastIndex = 0;
  const snap = await getGameSnapshot().catch(() => null);
  const ex = snap?.extracted || {};
  const ship = spec.targetShip
    ? (ex.ships || []).find((s) => s.name === spec.targetShip)
    : ((ex.ships || []).find((s) => s.primary) || null);
  const from = ship?.sector ?? ex.sector ?? null;
  if (from == null) return { sector: null, error: 'origin sector unknown' };
  const map = await getMapSectors().catch((err) => ({ ok: false, error: err.message }));
  if (!map?.ok) return { sector: null, error: map?.error || 'map fetch failed' };
  const frontier = findNearestFrontier(map.sectors, from);
  if (!frontier) return { sector: null, error: 'no unvisited frontier reachable via known space' };
  return { sector: frontier.sector, source: 'frontier-bfs', hops: frontier.hops };
};

const interpolateStartSector = (goal, resolved) => {
  const replacement = resolved?.sector != null
    ? String(resolved.sector)
    : 'pick the nearest unvisited sector from your current position';
  return (goal || '').replace(STARTING_SECTOR_TOKEN, replacement);
};

const missions = new Map();
const logSubscribers = new Map();

const evaluateCondition = (cond, snapshot) => {
  if (!cond || !snapshot?.extracted) return false;
  const v = snapshot.extracted[cond.metric];
  if (v == null) return false;
  switch (cond.op) {
    case '<': return v < cond.value;
    case '<=': return v <= cond.value;
    case '>': return v > cond.value;
    case '>=': return v >= cond.value;
    case '==': return v === cond.value;
    default: return false;
  }
};

const shipPhrase = (spec) =>
  spec.targetShip ? `the ${spec.targetShip}` : 'the fleet';

const safeRoutingClause = () => pick([
  'pick a safe megaport, closest if warp is tight.',
  'head for a safe megaport, closest works if warp is low.',
  'safe megaport preferred, closest otherwise.'
]);

const buildKickoffPrompt = (spec) => {
  const who = shipPhrase(spec);
  const rules = spec.guardrails?.length ? ` rules: ${spec.guardrails.join('; ')}.` : '';
  if (spec.targetShip) {
    return pick([
      `put ${who} on this. ${spec.goal}${rules}`,
      `new task for ${who}. ${spec.goal}${rules}`,
      `${who} assignment. ${spec.goal}${rules}`
    ]);
  }
  return pick([
    `${spec.goal}${rules}`,
    `fleet task. ${spec.goal}${rules}`,
    `heres the plan. ${spec.goal}${rules}`
  ]);
};

const buildNudgePrompt = (spec) => {
  const who = shipPhrase(spec);
  return pick([
    `looks like ${who}'s task stopped. pick it back up: ${spec.goal}`,
    `${who}'s task seems to have dropped. resume it: ${spec.goal}`,
    `${who} is idle again, back to it: ${spec.goal}`
  ]);
};

const reasonPhrase = (reason, snapshot) => {
  // Translate "warpPower<50" style into "warp is at 45"
  const m = reason.match(/^([a-zA-Z]+)(<=|>=|==|<|>)(-?\d+)/);
  if (!m || !snapshot) return reason;
  const [, metric, op, value] = m;
  const cur = snapshot?.extracted?.[metric];
  const labels = {
    warpPower: 'warp',
    credits: 'credits on hand',
    creditsOnHand: 'credits on hand',
    creditsBank: 'credits in the bank',
    fighters: 'fighters',
    shields: 'shields',
    cargo: 'cargo'
  };
  const label = labels[metric] || metric;
  if (cur != null) return `${label} is at ${cur} (target was ${op} ${value})`;
  return `${label} ${op} ${value}`;
};

const buildAbortPrompt = (spec, reason, snapshot) => {
  const who = shipPhrase(spec);
  const routing = safeRoutingClause();
  if (reason === 'user-abort' || reason === 'user') {
    return pick([
      `stand down on ${who}. recall to a safe megaport, top off warp, wait for my next call. ${routing}`,
      `pull ${who} back. safe megaport, refuel, hold for orders. ${routing}`,
      `wrap up ${who}. head to a safe megaport, recharge, standby. ${routing}`
    ]);
  }
  const phrase = reasonPhrase(reason, snapshot);
  return pick([
    `break off ${who}, ${phrase}. send it to a safe megaport and refuel, then wait. ${routing}`,
    `${who} needs to stop, ${phrase}. back to a megaport, top off, standby. ${routing}`,
    `${who} is done for now, ${phrase}. recall to a safe megaport and refuel. ${routing}`
  ]);
};

const buildStopPrompt = (spec, reason, snapshot) => {
  const who = shipPhrase(spec);
  const phrase = reasonPhrase(reason, snapshot);
  const routing = safeRoutingClause();
  return pick([
    `nice, target hit on ${who} (${phrase}). park the task, recall to a safe megaport, refuel, standby. ${routing}`,
    `we got it. ${who} hit ${phrase}. wrap the task, head to a megaport, top off, wait. ${routing}`,
    `${who} finished, ${phrase}. park it at a safe megaport and standby. ${routing}`
  ]);
};

/**
 * Parse the most recent chat timestamp — any event type (ASSISTANT, FUNCTION CALL, USER).
 * Messages render as "[HH:MM:SS] <TYPE>:..." in lastMessages (newest first).
 */
const lastChatMs = (snapshot) => {
  const msgs = snapshot?.extracted?.lastMessages || [];
  for (const m of msgs) {
    const match = m?.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (match) {
      const now = new Date();
      const stamp = new Date(now);
      stamp.setHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
      if (stamp.getTime() > now.getTime() + 60_000) stamp.setDate(stamp.getDate() - 1);
      return stamp.getTime();
    }
  }
  return null;
};

/**
 * Activity signals to detect when the agent is actually working.
 *
 * - Any task card with ENGINE STATUS: WORKING (authoritative — the game's own flag)
 * - Target corp ship badge showing ACTIVE
 * - Stat deltas since last poll (warp/sector/cargo/credits changed → ship is moving or trading)
 * - Recent chat event
 *
 * Returns { activeAt: ms, reasons: [...], stable: bool }.
 */
const detectActivity = (snapshot, mission) => {
  const reasons = [];
  const ex = snapshot?.extracted || {};
  const now = Date.now();

  if (ex.anyTaskWorking) reasons.push('engine:working');

  if (mission.spec.targetShip) {
    const ship = (ex.ships || []).find((s) => s.name === mission.spec.targetShip);
    if (ship?.active === true) reasons.push(`ship:${ship.name}:active`);
  }

  const currentStats = {
    sector: ex.sector,
    warpPower: ex.warpPower,
    cargo: ex.cargo,
    credits: ex.credits,
    shipCredits: ex.shipCredits
  };
  if (mission.prevStats) {
    for (const k of Object.keys(currentStats)) {
      if (currentStats[k] != null && mission.prevStats[k] != null && currentStats[k] !== mission.prevStats[k]) {
        reasons.push(`stat:${k}:${mission.prevStats[k]}→${currentStats[k]}`);
      }
    }
  }
  mission.prevStats = currentStats;

  const chatMs = lastChatMs(snapshot);
  if (chatMs && now - chatMs < 120_000) {
    reasons.push(`chat:${Math.round((now - chatMs) / 1000)}s`);
  }

  const active = reasons.length > 0;
  if (active) mission.lastActivityAt = now;
  return { active, reasons };
};

const snapshotForShip = (snapshot, targetShip) => {
  if (!snapshot?.extracted) return null;
  const ex = snapshot.extracted;
  if (!targetShip) return ex;
  const ship = (ex.ships || []).find((s) => s.name === targetShip);
  if (!ship) return ex;
  return {
    ...ex,
    sector: ship.sector ?? ex.sector,
    warpPower: ship.warpPower,
    fighters: ship.fighters,
    shields: ship.shields,
    cargo: ship.cargo ?? ex.cargo,
    shipCredits: ship.credits
  };
};

const appendLog = (mission, entry) => {
  const stamped = { ts: Date.now(), ...entry };
  mission.log.push(stamped);
  if (mission.log.length > 500) mission.log.splice(0, mission.log.length - 500);
  const subs = logSubscribers.get(mission.id);
  if (subs) for (const fn of subs) fn(stamped);
};

/**
 * A tick is a passive snapshot + condition check. Prompts only fire on:
 *   - kickoff (once)
 *   - abort / stop condition
 *   - all activity signals silent for ≥ spec.nudgeAfterIdleSec
 *
 * "Activity" = ENGINE STATUS: WORKING on any task, target corp ship ACTIVE,
 * stat deltas since last poll, or recent chat event. While any is present,
 * the idle clock resets.
 */
const runTick = async (mission) => {
  if (mission.status !== 'running') return;
  const spec = mission.spec;
  const rawSnapshot = await getGameSnapshot();
  mission.lastSnapshot = rawSnapshot;
  const shipView = snapshotForShip(rawSnapshot, spec.targetShip);
  const scoped = { ok: rawSnapshot?.ok, extracted: shipView };

  const activity = detectActivity(rawSnapshot, mission);
  const idleSec = mission.lastActivityAt
    ? Math.round((Date.now() - mission.lastActivityAt) / 1000)
    : Math.round((Date.now() - mission.startedAt) / 1000);

  appendLog(mission, {
    type: 'tick',
    snapshot: shipView,
    idleSec,
    activity: activity.active ? activity.reasons : null,
    taskCount: rawSnapshot?.extracted?.tasks?.length,
    tasksWorking: rawSnapshot?.extracted?.anyTaskWorking
  });

  if (spec.abortWhen) {
    for (const cond of spec.abortWhen) {
      if (evaluateCondition(cond, scoped)) {
        const reason = `${cond.metric}${cond.op}${cond.value}`;
        const prompt = buildAbortPrompt(spec, reason, scoped);
        const send = await sendAssistantPrompt(prompt);
        appendLog(mission, { type: 'abort', reason, prompt, send });
        mission.status = 'aborted';
        mission.endedAt = Date.now();
        return;
      }
    }
  }

  if (spec.stopWhen) {
    for (const cond of spec.stopWhen) {
      if (evaluateCondition(cond, scoped)) {
        const reason = `${cond.metric}${cond.op}${cond.value}`;
        const prompt = buildStopPrompt(spec, reason, scoped);
        const send = await sendAssistantPrompt(prompt);
        appendLog(mission, { type: 'stop', reason, prompt, send });
        mission.status = 'completed';
        mission.endedAt = Date.now();
        return;
      }
    }
  }

  if (mission.tickCount === 0) {
    const prompt = buildKickoffPrompt(spec);
    const send = await sendAssistantPrompt(prompt);
    mission.lastPromptAt = Date.now();
    mission.lastActivityAt = Date.now();
    appendLog(mission, { type: 'kickoff', text: prompt, send });
    // Chat confirmation isn't ground truth — the task engine sometimes silently
    // drops a dispatch. Watch snapshot for a working-task change or active flip.
    if (send?.ok) {
      verifyDispatch(mission.spec.targetShip)
        .then((verify) => {
          if (mission.status !== 'running') return;
          appendLog(mission, {
            type: 'verify-dispatch',
            landed: verify.landed,
            reason: verify.reason,
            wallMs: verify.wallMs
          });
        })
        .catch((err) => {
          if (mission.status !== 'running') return;
          appendLog(mission, { type: 'verify-dispatch', error: err.message });
        });
    }
  } else if (
    spec.nudgeAfterIdleSec > 0 &&
    !activity.active &&
    idleSec >= spec.nudgeAfterIdleSec &&
    Date.now() - (mission.lastPromptAt || 0) >= spec.nudgeAfterIdleSec * 1000
  ) {
    const prompt = buildNudgePrompt(spec);
    const send = await sendAssistantPrompt(prompt);
    mission.lastPromptAt = Date.now();
    mission.lastActivityAt = Date.now();
    appendLog(mission, { type: 'nudge', idleSec, text: prompt, send });
  }

  mission.tickCount += 1;
};

const scheduleNext = (mission) => {
  if (mission.status !== 'running') return;
  const interval = Math.max(5, Number(mission.spec.intervalSec) || 60) * 1000;
  mission.timer = setTimeout(async () => {
    await runTick(mission).catch((err) => {
      appendLog(mission, { type: 'error', error: err.message });
    });
    scheduleNext(mission);
  }, interval);
};

export const createMission = async (spec) => {
  // Resolve the starting sector (user override or server-side BFS) before we
  // freeze the goal text. Missions that don't use {{startSector}} skip the
  // DOM read entirely — resolveStartSector short-circuits when the placeholder
  // isn't present in the goal.
  const startRes = await resolveStartSector(spec).catch((err) => ({ sector: null, error: err.message }));
  const goalText = interpolateStartSector(spec.goal, startRes);
  const mission = {
    id: randomUUID(),
    spec: {
      goal: String(goalText),
      targetShip: spec.targetShip ? String(spec.targetShip) : null,
      guardrails: Array.isArray(spec.guardrails) ? spec.guardrails : [],
      intervalSec: Number(spec.intervalSec) || 30,
      nudgeAfterIdleSec: spec.nudgeAfterIdleSec === 0 ? 0 : (Number(spec.nudgeAfterIdleSec) || 270),
      abortWhen: Array.isArray(spec.abortWhen) ? spec.abortWhen : [],
      stopWhen: Array.isArray(spec.stopWhen) ? spec.stopWhen : [],
      maxTicks: Number(spec.maxTicks) || 0,
      startSector: startRes?.sector ?? null,
      startSectorSource: startRes?.source ?? null
    },
    lastPromptAt: 0,
    status: 'running',
    tickCount: 0,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    prevStats: null,
    endedAt: null,
    lastSnapshot: null,
    log: [],
    timer: null
  };
  missions.set(mission.id, mission);
  appendLog(mission, {
    type: 'start',
    goal: mission.spec.goal,
    startSector: mission.spec.startSector,
    startSectorSource: mission.spec.startSectorSource,
    startSectorError: startRes?.error || null
  });

  await runTick(mission).catch((err) => {
    appendLog(mission, { type: 'error', error: err.message });
  });
  scheduleNext(mission);

  return serializeMission(mission);
};

export const abortMission = async (id) => {
  const mission = missions.get(id);
  if (!mission) return { ok: false, error: 'not found' };
  if (mission.timer) clearTimeout(mission.timer);
  mission.status = 'aborted';
  mission.endedAt = Date.now();
  const prompt = buildAbortPrompt(mission.spec, 'user-abort', mission.lastSnapshot);
  const send = await sendAssistantPrompt(prompt).catch((e) => ({ ok: false, error: e.message }));
  appendLog(mission, { type: 'abort', reason: 'user', prompt, send });
  return { ok: true };
};

/**
 * Silently stop tracking a mission without sending any order to the game agent.
 * Use when the in-game task has already ended / drifted and you just want the
 * mission row out of the companion's list.
 */
export const untrackMission = (id) => {
  const mission = missions.get(id);
  if (!mission) return { ok: false, error: 'not found' };
  if (mission.timer) clearTimeout(mission.timer);
  missions.delete(id);
  logSubscribers.delete(id);
  return { ok: true };
};

const serializeMission = (m) => ({
  id: m.id,
  spec: m.spec,
  status: m.status,
  tickCount: m.tickCount,
  startedAt: m.startedAt,
  endedAt: m.endedAt,
  lastSnapshot: m.lastSnapshot?.extracted || null,
  log: m.log.slice(-100)
});

export const getMission = (id) => {
  const m = missions.get(id);
  return m ? serializeMission(m) : null;
};

export const listMissions = () =>
  Array.from(missions.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(serializeMission);

export const subscribeMissionLog = (id, fn) => {
  if (!logSubscribers.has(id)) logSubscribers.set(id, new Set());
  const set = logSubscribers.get(id);
  set.add(fn);
  return () => { set.delete(fn); };
};
