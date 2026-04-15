import express from 'express';
import { connectGamePage, getGameSnapshot, sendAssistantPrompt, getConnectionStatus, loginIfNeeded, selectCharacterIfNeeded } from './cdp.js';
import { createMission, listMissions, getMission, abortMission, untrackMission, subscribeMissionLog } from './missions.js';
import { loadMissionTemplates, saveMissionTemplate, deleteMissionTemplate } from './templates.js';
import { credentialsStatus, setCredentials, clearCredentials } from './credentials.js';
import { startAutopilot, stopAutopilot, getAutopilotState, subscribeAutopilotLog } from './autopilot.js';
import { getIntel, addManualEvent, updateEvent as updateIntelEvent, deleteEvent, clearIntel, observe as intelObserve } from './intel.js';

const PORT = Number(process.env.PORT || 5570);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '256kb' }));

const log = (emoji, msg, extra = {}) => {
  const suffix = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  console.log(`${emoji} ${new Date().toISOString()} ${msg}${suffix}`);
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/api/cdp/status', async (_req, res) => {
  const status = await getConnectionStatus();
  res.json(status);
});

app.post('/api/cdp/connect', async (_req, res) => {
  log('🔌', 'CDP connect requested');
  const result = await connectGamePage();
  log(result.ok ? '✅' : '❌', `CDP connect ${result.ok ? 'ok' : 'failed'}`, { url: result.url, error: result.error });
  res.json(result);
});

app.get('/api/game/snapshot', async (_req, res) => {
  const snap = await getGameSnapshot();
  res.json(snap);
});

app.post('/api/assistant/prompt', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'text required' });
  }
  log('💬', 'Direct prompt sent', { len: text.length });
  const result = await sendAssistantPrompt(text);
  res.json(result);
});

app.post('/api/fleet/recall-refuel', async (_req, res) => {
  const { getGameSnapshot } = await import('./cdp.js');
  const { dangerousSectors } = await import('./intel.js');
  const snap = await getGameSnapshot();
  const ships = (snap?.extracted?.ships || []).map((s) => s.name).filter(Boolean);
  const bad = dangerousSectors();
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const routing = bad.length
    ? pick([
        `try to route around sectors ${bad.slice(0, 8).join(', ')} (we lost ships there). if any ship cant reach a safe port on current warp, closest megaport is fine, dont strand them.`,
        `avoid ${bad.slice(0, 8).join(', ')} if possible, otherwise closest megaport wins over getting stranded.`
      ])
    : `send each ship to the closest safe megaport.`;
  const fleetLabel = ships.length ? ships.join(', ') : 'the whole corp fleet';
  const text = pick([
    `fleet recall. pause any active tasks on ${fleetLabel}, send every ship to a safe megaport, top off warp. ${routing} once docked and full, standby for new orders.`,
    `regroup time. pause everything on ${fleetLabel}, get each ship to a safe megaport, refuel fully, hold for orders. ${routing}`,
    `all ships recall. stop current tasks on ${fleetLabel}, head to safe megaports, refuel, standby. ${routing}`
  ]);
  log('🚨', 'Fleet recall & refuel', { shipCount: ships.length, dangerous: bad.length });
  const result = await sendAssistantPrompt(text);
  res.json({ ok: !!result.ok, text, shipCount: ships.length, send: result });
});

app.get('/api/missions', (_req, res) => {
  res.json({ missions: listMissions() });
});

app.get('/api/missions/:id', (req, res) => {
  const mission = getMission(req.params.id);
  if (!mission) return res.status(404).json({ ok: false, error: 'not found' });
  res.json(mission);
});

app.post('/api/missions', async (req, res) => {
  const spec = req.body || {};
  if (!spec.goal || typeof spec.goal !== 'string') {
    return res.status(400).json({ ok: false, error: 'goal required' });
  }
  const mission = await createMission(spec);
  log('🚀', 'Mission created', { id: mission.id, goal: spec.goal.slice(0, 60) });
  res.json(mission);
});

app.post('/api/missions/:id/abort', async (req, res) => {
  const result = await abortMission(req.params.id);
  log('🛑', 'Mission abort', { id: req.params.id, ok: result.ok });
  res.json(result);
});

app.delete('/api/missions/:id', (req, res) => {
  const result = untrackMission(req.params.id);
  log('🧹', 'Mission untracked', { id: req.params.id, ok: result.ok });
  res.json(result);
});

app.get('/api/missions/:id/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const write = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const existing = getMission(req.params.id);
  if (!existing) {
    write('error', { error: 'mission not found' });
    res.end();
    return;
  }
  write('snapshot', existing);

  const unsubscribe = subscribeMissionLog(req.params.id, (entry) => {
    write('log', entry);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

app.get('/api/autopilot', (_req, res) => {
  res.json(getAutopilotState());
});

app.get('/api/intel', (_req, res) => {
  res.json(getIntel());
});

app.post('/api/intel/events', (req, res) => {
  const { type, ship, attacker, sector, note } = req.body || {};
  const ev = addManualEvent({ type, ship, attacker, sector: sector != null ? Number(sector) : null, note });
  log('📜', 'Intel event logged', { type: ev.type, attacker, sector });
  res.json(ev);
});

app.patch('/api/intel/events/:id', (req, res) => {
  res.json(updateIntelEvent(req.params.id, req.body || {}));
});

app.delete('/api/intel/events/:id', (req, res) => {
  res.json(deleteEvent(req.params.id));
});

app.post('/api/intel/query-attackers', async (req, res) => {
  const { ships } = req.body || {};
  const shipList = Array.isArray(ships) && ships.length ? ships.join(', ') : 'our destroyed ships';
  const prompt = `Quick intel request: use event_query to look up the combat events for ${shipList}. For each one, tell me the attacker's player name and sector. No need to act on it — just report the names and sectors.`;
  const send = await (await import('./cdp.js')).sendAssistantPrompt(prompt).catch((e) => ({ ok: false, error: e.message }));
  log('📜', 'Asked agent to identify attackers', { ships: shipList, ok: send.ok });
  res.json({ ok: !!send.ok, send, prompt });
});

app.delete('/api/intel', (_req, res) => {
  clearIntel();
  res.json({ ok: true });
});

app.post('/api/intel/scan', async (_req, res) => {
  const snap = await (await import('./cdp.js')).getGameSnapshot();
  const added = intelObserve(snap);
  res.json({ ok: true, added });
});

app.post('/api/autopilot/start', (req, res) => {
  const result = startAutopilot(req.body || {});
  log(result.ok ? '🤖' : '⚠️', `Autopilot start ${result.ok ? 'ok' : 'failed'}`, { error: result.error });
  res.json(result);
});

app.post('/api/autopilot/stop', (_req, res) => {
  const result = stopAutopilot();
  log('🛑', 'Autopilot stopped');
  res.json(result);
});

app.get('/api/autopilot/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write('snapshot', getAutopilotState());
  const unsubscribe = subscribeAutopilotLog((entry) => write('log', entry));
  req.on('close', () => unsubscribe());
});

app.get('/api/credentials', (_req, res) => {
  res.json(credentialsStatus());
});

app.post('/api/credentials', (req, res) => {
  const { email, password, character } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });
  const result = setCredentials({ email, password, character });
  log('🔐', 'Credentials stored', { backend: result.backend, email, character });
  res.json(result);
});

app.post('/api/cdp/select-character', async (req, res) => {
  const { name } = req.body || {};
  const result = await selectCharacterIfNeeded(name);
  log(result.ok ? '🧑' : '⚠️', `Character select ${result.via || result.error}`);
  res.json(result);
});

app.delete('/api/credentials', (_req, res) => {
  clearCredentials();
  log('🔓', 'Credentials cleared');
  res.json({ ok: true });
});

app.post('/api/cdp/login', async (_req, res) => {
  log('🔑', 'Auto-login requested');
  const result = await loginIfNeeded();
  log(result.ok ? '✅' : '❌', `Login ${result.ok ? 'ok' : 'failed'}`, { via: result.via, error: result.error });
  res.json(result);
});

app.get('/api/templates', (_req, res) => {
  res.json({ templates: loadMissionTemplates() });
});

app.post('/api/templates', (req, res) => {
  const { name, spec } = req.body || {};
  if (!name || !spec) return res.status(400).json({ ok: false, error: 'name and spec required' });
  saveMissionTemplate(name, spec);
  res.json({ ok: true });
});

app.delete('/api/templates/:name', (req, res) => {
  deleteMissionTemplate(req.params.name);
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  log('🛰️', `gradient-play server listening on http://${HOST}:${PORT}`);
  log('🎯', `CDP endpoint ${process.env.CDP_ENDPOINT || 'http://127.0.0.1:5556'}`);
});
