import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'templates.json');

const ensureDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const builtins = [
  {
    name: 'Trade until low fuel',
    spec: {
      goal: 'Continue running profitable trades. Keep an eye on warp power and distance to the nearest megaport. If you must refuel, plot course to the nearest megaport and recharge.',
      guardrails: [
        'Abort trades if warp power drops below 50',
        'Prioritize NS commodity routes for margin',
        'Never engage combat — flee if attacked'
      ],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [{ metric: 'warpPower', op: '<', value: 50 }],
      stopWhen: []
    }
  },
  {
    name: 'Trade toward next ship upgrade',
    spec: {
      goal: 'Continue running profitable trades until we have enough credits (bank + on-hand) to purchase the next ship upgrade from our current ship, refueling at a megaport whenever warp power drops low. Once we have the credits, fly to a megaport, trade in our current ship, and purchase the upgrade. Then resume trading in the new ship.',
      guardrails: [
        'Refuel before warp power hits 50; do not run out mid-route',
        'Prioritize NS (Neuro-Symbolics) routes for highest margin',
        'Do not engage combat — flee if attacked'
      ],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [],
      stopWhen: []
    }
  },
  {
    name: 'Pure exploration (Kestrel)',
    spec: {
      goal: 'Explore unvisited sectors at the periphery of my known map. Flee from any combat. Return to a megaport to recharge warp before it hits 30.',
      guardrails: ['Flee all combat', 'Do not engage garrisons'],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [{ metric: 'warpPower', op: '<', value: 30 }]
    }
  },
  {
    name: 'Probe: autonomous exploration',
    spec: {
      goal: 'Start an autonomous exploration task on this ship: visit every sector within 40 hops that I have not yet mapped.',
      guardrails: ['Flee all combat', 'Do not attempt trades (0 cargo)'],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [{ metric: 'warpPower', op: '<', value: 20 }]
    }
  },
  {
    name: 'Probe: salvage patrol',
    spec: {
      goal: 'Patrol unmapped space hunting for salvage drops from recent combat. Whenever you arrive in a sector, check for salvage — if there is any, claim it with salvage_collect (it has a 900s TTL so speed matters). Any credits picked up must be deposited in the bank at the next megaport visit — do not carry loose credits on the probe. Refuel whenever you need to. Between salvage finds, keep exploring new sectors to widen the search. You have no shields and only 10 fighters, so flee any combat immediately.',
      guardrails: [
        'Flee every combat encounter — no exceptions',
        'Deposit all credits at every megaport visit',
        'Refuel before warp power drops below 80',
        'Prefer unmapped sectors to maximize salvage hit rate',
        'Do not engage garrisons or toll gates'
      ],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [{ metric: 'warpPower', op: '<', value: 30 }]
    }
  },
  {
    name: 'Light Hauler: short trade loop',
    spec: {
      goal: 'Start an autonomous trade task on this Light Hauler: identify a 2–3 hop profitable loop near its current sector and run it continuously. Steer the task if port depletion reduces margins below 20 cr/unit.',
      guardrails: ['Refuel at a megaport when warp drops below 100'],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: []
    }
  },
  {
    name: 'Grind tutorial to 1000 credits',
    spec: {
      goal: 'Complete the tutorial quest. Trade between adjacent ports for small profits until you have 1000 credits aggregate, then claim rewards.',
      guardrails: ['Do not buy fighters', 'Do not leave fedspace'],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      stopWhen: [{ metric: 'credits', op: '>=', value: 1000 }]
    }
  }
];

export const loadMissionTemplates = () => {
  ensureDir();
  const user = fs.existsSync(FILE)
    ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
    : [];
  const userByName = new Map(user.map((t) => [t.name, t]));
  const out = [];
  for (const b of builtins) {
    const u = userByName.get(b.name);
    if (u) {
      out.push({ name: b.name, spec: u.spec, source: 'override', builtin: true });
    } else {
      out.push({ name: b.name, spec: b.spec, source: 'builtin', builtin: true });
    }
  }
  const builtinNames = new Set(builtins.map((b) => b.name));
  for (const u of user) {
    if (!builtinNames.has(u.name)) {
      out.push({ name: u.name, spec: u.spec, source: 'user', builtin: false });
    }
  }
  return out;
};

export const saveMissionTemplate = (name, spec) => {
  ensureDir();
  const existing = fs.existsSync(FILE)
    ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
    : [];
  const filtered = existing.filter((t) => t.name !== name);
  filtered.push({ name, spec });
  fs.writeFileSync(FILE, JSON.stringify(filtered, null, 2));
};

export const deleteMissionTemplate = (name) => {
  if (!fs.existsSync(FILE)) return;
  const existing = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  fs.writeFileSync(FILE, JSON.stringify(existing.filter((t) => t.name !== name), null, 2));
};
