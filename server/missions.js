import { randomUUID } from 'node:crypto';
import { getGameSnapshot, sendAssistantPrompt } from './cdp.js';

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

const buildKickoffPrompt = (spec) => {
  const parts = [];
  const prefix = spec.targetShip ? `Using ${spec.targetShip}: ` : '';
  parts.push(prefix + spec.goal);
  if (spec.guardrails?.length) {
    parts.push('Guardrails: ' + spec.guardrails.join('; '));
  }
  return parts.join('\n');
};

const buildNudgePrompt = (spec) => {
  const who = spec.targetShip ? `${spec.targetShip}` : 'the fleet';
  return `Status check on ${who}. If the previous task has stopped or timed out, resume it without losing progress: ${spec.goal.slice(0, 200)}`;
};

const buildAbortPrompt = (spec, reason) => {
  const who = spec.targetShip ? spec.targetShip : 'the fleet';
  return `Abort current activity for ${who}. Reason: ${reason}. Stop trading/exploring and return to the nearest megaport to recharge. Await further orders.`;
};

const buildStopPrompt = (spec, reason) => {
  const who = spec.targetShip ? spec.targetShip : 'the fleet';
  return `Goal reached for ${who} (${reason}). Pause the current task. Await further orders.`;
};

/**
 * Parse the most recent assistant message timestamp from the chat scrape.
 * Messages render as "[HH:MM:SS] ASSISTANT:\n..." in lastMessages (newest first).
 * Returns epoch ms of the most recent assistant message today, or null.
 */
const lastAssistantMs = (snapshot) => {
  const msgs = snapshot?.extracted?.lastMessages || [];
  for (const m of msgs) {
    const match = m?.match(/\[(\d{2}):(\d{2}):(\d{2})\]\s*ASSISTANT/i);
    if (match) {
      const now = new Date();
      const stamp = new Date(now);
      stamp.setHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
      // If the stamp is in the future (crossed midnight), subtract a day.
      if (stamp.getTime() > now.getTime() + 60_000) stamp.setDate(stamp.getDate() - 1);
      return stamp.getTime();
    }
  }
  return null;
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
 * A tick is a passive snapshot + condition check. Prompts are only sent on:
 *   - kickoff (first tick)
 *   - abort condition fires
 *   - stop condition fires
 *   - assistant has been idle longer than spec.nudgeAfterIdleSec (5-min game timeout)
 */
const runTick = async (mission) => {
  if (mission.status !== 'running') return;
  const spec = mission.spec;
  const rawSnapshot = await getGameSnapshot();
  mission.lastSnapshot = rawSnapshot;
  const shipView = snapshotForShip(rawSnapshot, spec.targetShip);
  const scoped = { ok: rawSnapshot?.ok, extracted: shipView };

  const assistantMs = lastAssistantMs(rawSnapshot);
  const idleSec = assistantMs ? Math.round((Date.now() - assistantMs) / 1000) : null;
  appendLog(mission, { type: 'tick', snapshot: shipView, idleSec });

  if (spec.abortWhen) {
    for (const cond of spec.abortWhen) {
      if (evaluateCondition(cond, scoped)) {
        const reason = `${cond.metric}${cond.op}${cond.value}`;
        const prompt = buildAbortPrompt(spec, reason);
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
        const prompt = buildStopPrompt(spec, reason);
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
    appendLog(mission, { type: 'kickoff', text: prompt, send });
  } else if (
    spec.nudgeAfterIdleSec > 0 &&
    idleSec != null &&
    idleSec >= spec.nudgeAfterIdleSec &&
    Date.now() - (mission.lastPromptAt || 0) >= spec.nudgeAfterIdleSec * 1000
  ) {
    const prompt = buildNudgePrompt(spec);
    const send = await sendAssistantPrompt(prompt);
    mission.lastPromptAt = Date.now();
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
  const prompt = buildAbortPrompt(mission.spec, 'user-abort');
  const send = await sendAssistantPrompt(prompt).catch((e) => ({ ok: false, error: e.message }));
  appendLog(mission, { type: 'abort', reason: 'user', prompt, send });
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
