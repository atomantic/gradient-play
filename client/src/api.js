const BASE = '';

const req = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
};

export const api = {
  status: () => req('GET', '/api/cdp/status'),
  connect: () => req('POST', '/api/cdp/connect'),
  snapshot: () => req('GET', '/api/game/snapshot'),
  sendPrompt: (text) => req('POST', '/api/assistant/prompt', { text }),
  missions: () => req('GET', '/api/missions'),
  mission: (id) => req('GET', `/api/missions/${id}`),
  createMission: (spec) => req('POST', '/api/missions', spec),
  abortMission: (id) => req('POST', `/api/missions/${id}/abort`),
  untrackMission: (id) => req('DELETE', `/api/missions/${id}`),
  templates: () => req('GET', '/api/templates'),
  saveTemplate: (name, spec) => req('POST', '/api/templates', { name, spec }),
  deleteTemplate: (name) => req('DELETE', `/api/templates/${encodeURIComponent(name)}`),
  glitchState: () => req('GET', '/api/glitch/state'),
  glitchArm: () => req('POST', '/api/glitch/arm'),
  glitchDisarm: () => req('POST', '/api/glitch/disarm'),
  glitchClearCapture: () => req('DELETE', '/api/glitch/capture'),
  glitchFire: (body) => req('POST', '/api/glitch/fire', body)
};

export const streamMission = (id, { onLog, onSnapshot, onError } = {}) => {
  const es = new EventSource(`/api/missions/${id}/stream`);
  es.addEventListener('log', (e) => onLog?.(JSON.parse(e.data)));
  es.addEventListener('snapshot', (e) => onSnapshot?.(JSON.parse(e.data)));
  es.addEventListener('error', (e) => onError?.(e));
  return () => es.close();
};
