import express from 'express';
import { connectGamePage, getGameSnapshot, sendAssistantPrompt, getConnectionStatus, loginIfNeeded } from './cdp.js';
import { createMission, listMissions, getMission, abortMission, subscribeMissionLog } from './missions.js';
import { loadMissionTemplates, saveMissionTemplate, deleteMissionTemplate } from './templates.js';
import { credentialsStatus, setCredentials, clearCredentials } from './credentials.js';

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

app.get('/api/credentials', (_req, res) => {
  res.json(credentialsStatus());
});

app.post('/api/credentials', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });
  const result = setCredentials({ email, password });
  log('🔐', 'Credentials stored', { backend: result.backend, email });
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
