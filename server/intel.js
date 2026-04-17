/**
 * Threat intel: track hostile encounters, ship destructions, and known-dangerous
 * sectors. Sources:
 *   - DOM diff: ships marked DESTROYED in the fleet panel, ships that vanish
 *     between snapshots (probe/hauler was present, now gone).
 *   - Chat parse: assistant messages reporting combat/destruction events.
 *   - Manual: user-entered observations.
 *
 * Persisted to server/data/intel.json so history survives restarts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'intel.json');

const ensureDir = () => { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); };

const emptyStore = () => ({ events: [], seenShips: {}, updatedAt: null });

const load = () => {
  if (!fs.existsSync(FILE)) return emptyStore();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return emptyStore(); }
  // Cleanup: "vanished" was a DOM-diff heuristic that fires false positives on
  // every disconnect (all ships disappear at once). Strip any existing records
  // so the threat log reflects real destructions only.
  if (Array.isArray(parsed.events)) {
    const before = parsed.events.length;
    parsed.events = parsed.events.filter((e) => e.type !== 'vanished');
    if (parsed.events.length !== before) {
      console.log(`🧹 intel: removed ${before - parsed.events.length} stale 'vanished' events on load`);
    }
  }
  return parsed;
};

const save = (store) => {
  ensureDir();
  store.updatedAt = Date.now();
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
};

let store = load();
// Persist any cleanup from load() immediately.
if (store.events?.length != null) save(store);

const addEvent = (ev) => {
  const stamped = { id: randomUUID(), ts: ev.ts || Date.now(), source: 'manual', ...ev };
  // Remove the ts override — keep whatever callers passed.
  if (ev.ts) stamped.ts = ev.ts;
  store.events.push(stamped);
  // Keep 500 most recent.
  if (store.events.length > 500) store.events.splice(0, store.events.length - 500);
  save(store);
  return stamped;
};

export const updateEvent = (id, patch) => {
  const ev = store.events.find((e) => e.id === id);
  if (!ev) return { ok: false, error: 'not found' };
  Object.assign(ev, patch);
  save(store);
  return { ok: true, event: ev };
};

// Chat patterns for hostile events. Each captures (ship?, attacker?, sector?).
const CHAT_PATTERNS = [
  {
    type: 'destroyed-by',
    // "Your probe has been destroyed by AttackerName in sector 1234"
    re: /(?:your|the|our)?\s*(\w[\w\s-]*?)\s+(?:has\s+been|was)\s+destroyed\s+by\s+([A-Za-z][\w-]*)(?:\s+in\s+sector\s+(\d+))?/i
  },
  {
    type: 'destroyed',
    re: /(?:your|the|our)?\s*(\w[\w\s-]*?)\s+(?:has\s+been|was)\s+destroyed(?:\s+in\s+sector\s+(\d+))?/i,
    groups: { ship: 1, sector: 2 }
  },
  {
    type: 'attacked-by',
    re: /(?:your|the|our)?\s*(\w[\w\s-]*?)\s+(?:was|is\s+being|has\s+been)\s+attacked\s+by\s+([A-Za-z][\w-]*)(?:\s+in\s+sector\s+(\d+))?/i
  },
  {
    type: 'combat-engaged',
    re: /combat\s+(?:engaged|initiated)\s+(?:with|by|against)\s+([A-Za-z][\w-]*)(?:\s+in\s+sector\s+(\d+))?/i,
    groups: { attacker: 1, sector: 2 }
  }
];

const parseChatMessage = (msg) => {
  if (!msg || !/ASSISTANT[:\s]/i.test(msg)) return null;
  for (const p of CHAT_PATTERNS) {
    const m = msg.match(p.re);
    if (!m) continue;
    if (p.groups) {
      return {
        type: p.type,
        ship: p.groups.ship ? (m[p.groups.ship] || '').trim() : null,
        attacker: p.groups.attacker ? m[p.groups.attacker] : null,
        sector: p.groups.sector ? Number(m[p.groups.sector]) : null
      };
    }
    return {
      type: p.type,
      ship: (m[1] || '').trim(),
      attacker: m[2] || null,
      sector: m[3] ? Number(m[3]) : null
    };
  }
  return null;
};

const msgKey = (msg) => {
  const tsMatch = msg.match(/\[(\d{2}:\d{2}:\d{2})\]/);
  return (tsMatch ? tsMatch[1] : '') + '|' + (msg.slice(0, 120));
};

const seenMsgKeys = new Set();

/**
 * Process a snapshot: detect destroyed / vanished ships via DOM diff, parse
 * chat messages for hostile events. Returns new events added.
 */
export const observe = (snapshot) => {
  const ex = snapshot?.extracted || {};
  const added = [];

  // "Destroyed Ships" table — authoritative list with sector + rough when.
  // Upsert one event per ship+sector; if the user had a manual record with a
  // missing sector, patch it in place rather than creating a duplicate.
  for (const row of ex.destroyedShips || []) {
    if (!row?.name) continue;
    const existing = store.events.find((e) =>
      e.type === 'destroyed' && e.ship && e.ship.toLowerCase() === row.name.toLowerCase());
    if (existing) {
      const patched = {};
      if (existing.sector == null && row.sector != null) patched.sector = row.sector;
      if (!existing.destroyedAgo && row.destroyedAgo) patched.destroyedAgo = row.destroyedAgo;
      if (Object.keys(patched).length) {
        Object.assign(existing, patched, { source: existing.source === 'manual' ? 'manual+dom' : 'dom' });
        save(store);
      }
      continue;
    }
    // Parse destroyed_at timestamp from RPC blob if available.
    let ts = Date.now();
    const rpc = (ex.destroyedShipsRpc || []).find((r) => r.name === row.name);
    if (rpc?.destroyed_at) {
      const t = Date.parse(rpc.destroyed_at);
      if (!isNaN(t)) ts = t;
    }
    added.push(addEvent({
      type: 'destroyed',
      source: 'dom-table',
      ship: row.name,
      shipType: row.type,
      sector: row.sector,
      destroyedAgo: row.destroyedAgo,
      ts
    }));
  }

  // DOM-based: ships marked DESTROYED in the fleet panel.
  // New destroyed flag transitions.
  for (const s of ex.ships || []) {
    const prev = store.seenShips[s.name];
    const wasDestroyed = prev?.destroyed === true;
    const nowDestroyed = s.destroyed === true;
    if (nowDestroyed && !wasDestroyed) {
      added.push(addEvent({
        type: 'destroyed',
        source: 'dom',
        ship: s.name,
        sector: s.sector ?? prev?.sector ?? null,
        note: 'Fleet panel shows DESTROYED label'
      }));
    }
    store.seenShips[s.name] = {
      destroyed: s.destroyed,
      sector: s.sector ?? prev?.sector ?? null,
      lastSeen: Date.now()
    };
  }

  // (Previously: DOM-diff "vanished" detection. Removed — it fires every time
  // the CDP or game connection drops and the fleet panel re-renders empty,
  // which produced a flood of false-positive threat events. Real destructions
  // come from the DESTROYED flag transition above and the destroyedShips table.)
  save(store);

  // Chat-based: parse timestamped assistant messages.
  for (const msg of ex.lastMessages || []) {
    if (!msg) continue;
    const k = msgKey(msg);
    if (seenMsgKeys.has(k)) continue;
    seenMsgKeys.add(k);
    const parsed = parseChatMessage(msg);
    if (!parsed) continue;
    added.push(addEvent({
      type: parsed.type,
      source: 'chat',
      ship: parsed.ship,
      attacker: parsed.attacker,
      sector: parsed.sector,
      snippet: msg.slice(0, 300)
    }));
  }

  return added;
};

export const addManualEvent = ({ type, ship, attacker, sector, note }) => {
  return addEvent({ type: type || 'manual', source: 'manual', ship, attacker, sector, note });
};

export const deleteEvent = (id) => {
  store.events = store.events.filter((e) => e.id !== id);
  save(store);
  return { ok: true };
};

export const clearIntel = () => {
  store = emptyStore();
  save(store);
  seenMsgKeys.clear();
  return { ok: true };
};

/**
 * Aggregate hostile players and dangerous sectors from the event log.
 */
export const getIntel = () => {
  const players = new Map();
  const sectors = new Map();
  for (const e of store.events) {
    if (e.attacker) {
      const p = players.get(e.attacker) || { name: e.attacker, events: 0, sectors: new Set(), lastSeen: 0, lastType: null };
      p.events += 1;
      if (e.sector != null) p.sectors.add(e.sector);
      if (e.ts > p.lastSeen) { p.lastSeen = e.ts; p.lastType = e.type; }
      players.set(e.attacker, p);
    }
    if (e.sector != null) {
      const s = sectors.get(e.sector) || { sector: e.sector, events: 0, lastSeen: 0, lastType: null, attackers: new Set() };
      s.events += 1;
      if (e.attacker) s.attackers.add(e.attacker);
      if (e.ts > s.lastSeen) { s.lastSeen = e.ts; s.lastType = e.type; }
      sectors.set(e.sector, s);
    }
  }
  const toArr = (m) => Array.from(m.values())
    .map((x) => ({ ...x, sectors: x.sectors ? Array.from(x.sectors) : undefined, attackers: x.attackers ? Array.from(x.attackers) : undefined }))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  return {
    events: store.events.slice().reverse(),
    players: toArr(players),
    sectors: toArr(sectors),
    updatedAt: store.updatedAt
  };
};
