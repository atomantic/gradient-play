import { randomUUID } from 'node:crypto';
import { getGameSnapshot, sendAssistantPrompt } from './cdp.js';
import { dangerousSectors } from './intel.js';

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

// Routing guidance for a recall-to-megaport command. Priority is:
// (1) don't get stranded, (2) prefer safe route, (3) accept closest if safe
// isn't reachable on current warp.
const safeRoutingClause = () => {
  const bad = dangerousSectors();
  if (!bad.length) return 'Prefer a safe megaport; if warp is too low to reach one safely, just go to the closest megaport — do not risk getting stranded.';
  const list = bad.slice(0, 8).join(', ');
  return `Prefer a safe megaport and plot around sectors ${list} (we've had ships destroyed there). But getting stranded is worse than running a risky sector, so if warp is too low to reach a safe port, head to the closest megaport — any megaport beats being stuck in empty space.`;
};

const buildKickoffPrompt = (spec) => {
  const lines = [];
  if (spec.targetShip) {
    lines.push(`Put ${shipPhrase(spec)} on this: ${spec.goal}`);
  } else {
    lines.push(spec.goal);
  }
  if (spec.guardrails?.length) {
    lines.push('A few ground rules: ' + spec.guardrails.join('; ') + '.');
  }
  return lines.join(' ');
};

const buildNudgePrompt = (spec) => {
  const who = shipPhrase(spec);
  // We only send this when DOM tells us the task died (engine idle + no stat deltas).
  // So don't ask for status — just re-kick.
  return `Looks like ${who}'s task dropped out. Pick it back up — ${spec.goal}`;
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
    return `Stand down on ${who} — recall it to a safe megaport, recharge warp to full, and wait for my next call. ${routing}`;
  }
  const phrase = reasonPhrase(reason, snapshot);
  return `Hey, break off whatever ${who} is doing — ${phrase}. Recall it to a safe megaport and recharge warp to full. ${routing} Then wait for orders.`;
};

const buildStopPrompt = (spec, reason, snapshot) => {
  const who = shipPhrase(spec);
  const phrase = reasonPhrase(reason, snapshot);
  const routing = safeRoutingClause();
  return `Nice, we hit the target on ${who} — ${phrase}. Park the task, recall ${who} to a safe megaport, and top off warp. ${routing} Await further orders.`;
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
  const mission = {
    id: randomUUID(),
    spec: {
      goal: String(spec.goal),
      targetShip: spec.targetShip ? String(spec.targetShip) : null,
      guardrails: Array.isArray(spec.guardrails) ? spec.guardrails : [],
      intervalSec: Number(spec.intervalSec) || 30,
      nudgeAfterIdleSec: spec.nudgeAfterIdleSec === 0 ? 0 : (Number(spec.nudgeAfterIdleSec) || 270),
      abortWhen: Array.isArray(spec.abortWhen) ? spec.abortWhen : [],
      stopWhen: Array.isArray(spec.stopWhen) ? spec.stopWhen : [],
      maxTicks: Number(spec.maxTicks) || 0
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
  appendLog(mission, { type: 'start', goal: mission.spec.goal });

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
