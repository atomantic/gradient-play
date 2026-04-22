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
    name: 'Probe: autonomous exploration',
    spec: {
      // Goal mirrors autopilot's explorer prompt (server/autopilot.js
      // probeTaskPrompt). {{startSector}} is resolved at mission create time:
      // user-supplied Starting sector field wins, otherwise the server walks
      // the React fiber's known-sector map and picks the nearest unvisited
      // frontier via BFS through visited space. Override via the composer if
      // you have a specific target in mind.
      goal: 'Start an autonomous exploration task on this ship. Go as far as you can exploring new sectors until you run out of fuel, starting at sector {{startSector}}. Use local_map_region each hop to pick the nearest unvisited neighbor. Prefer unvisited hops; if all neighbors are already known, transit through known sectors to reach fresh territory — do not halt just because the immediate neighbors are visited. Do not turn back to refuel.',
      guardrails: ['Flee all combat', 'Do not attempt trades (0 cargo)', 'Avoid tolls and hostile garrisons'],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [{ metric: 'warpPower', op: '<', value: 20 }]
    }
  },
  {
    name: 'Primary: salvage scan loop',
    spec: {
      // Mirrors fireSalvageScan() in autopilot.js — same prompt body, but
      // delivered as a recurring mission rather than a one-shot dispatch.
      // Use this template if you want the salvage sweep to nag the agent
      // on intervalSec instead of running purely on-demand from the UI.
      // The primary ship collects everything (credits + cargo + scrap);
      // probes can salvage_collect but only pocket the credits portion
      // because they have 0 cargo holds.
      goal: `SALVAGE SCAN LOOP — sweep the surrounding region for salvage and collect everything with value to your hold.
SETUP: my_status (note cargo capacity, current cargo, on-hand credits), then local_map_region(max_hops=10, max_sectors=200).
LOOP until the 10-hop radius is clean or you run low on warp:
  1. Find sectors whose salvage array is non-empty.
  2. Score each container = (estimated value to me) ÷ hops_away. Value = credits + (commodity units × spot price if I have hold space) + (scrap × 1 if I have hold space).
  3. plot_course → move → salvage_collect(salvage_id=<best>). If multiple containers in the destination, collect them all before leaving.
  4. Refresh local_map_region and repeat.
  5. If radius is empty: status.update "salvage zone clean" and either wait_in_idle_state (containers regen slowly from kills) or plot_course one hop in any direction to refresh the search radius.
FUEL: if warp <= 2 × turns_per_warp, plot_course nearest megaport, recharge_warp_power, resume.
Do NOT call finished — keep looping.`,
      guardrails: [
        'Sweep only — do not engage combat for salvage; flee any aggressor',
        'Avoid tolls and hostile garrisons',
        'Refuel at the nearest megaport when warp is low; do not strand',
        'salvage_collect every container in the current sector before moving on',
        'Stop only on stop_task or steer_task'
      ],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [{ metric: 'warpPower', op: '<', value: 30 }],
      stopWhen: []
    }
  },
  {
    name: 'Probe: explore & salvage',
    spec: {
      goal: 'Explore unmapped sectors, and on every sector arrival check for salvage and claim it. Deposit credits at each megaport visit. Unless I list known salvage sectors in your guardrails, default to unmapped sectors.',
      guardrails: [
        'Visit unmapped sectors by default',
        'Check for salvage on every sector arrival',
        'Deposit credits at each megaport visit',
        'Refuel before warp drops below 80',
        'Flee any combat',
        'No garrisons or toll gates'
      ],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [{ metric: 'warpPower', op: '<', value: 30 }]
    }
  },
  {
    name: 'Fleet: perpetual trade + probe refuel loop',
    spec: {
      goal: `Run all haulers and this ship on independent NS trade loops in federation space. Route choices are your own. Trade until the fleet runs low on warp power. Then:
1. Move this ship to sector 1413 (home megaport).
2. Use probes to refuel every grounded hauler via the stockpile system.
3. Any probe that runs out of fuel: sell it with sell_ship, then buy a fresh probe from the megaport at sector 1413.
4. Once all haulers are fueled, resume trading with the full fleet including this ship.
Repeat this cycle forever.`,
      guardrails: [
        'All ships trade in federation space only',
        'Haulers never divert to megaports for fuel — probes handle all refueling',
        'Refuel hub is always sector 1413',
        'Depleted probes are sold and replaced at sector 1413 before resuming',
        'Flee all combat',
        'No garrisons or toll gates'
      ],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [],
      stopWhen: []
    }
  },
  {
    name: 'Onboarding: sector 305 fedspace loop',
    spec: {
      goal: 'New-player onboarding loop anchored on megaport sector 305. First, plot_course to sector 305 and dock. Then find a short NS trade loop (2-3 hops) between sector 305 and adjacent federation ports and run it for max credits per warp. Whenever warp power drops to 50 or below, stop trading, plot_course back to sector 305, dock, and recharge_warp_power to full. Then resume the trade loop. Repeat indefinitely.',
      guardrails: [
        'Federation space only — never exit fedspace',
        'Trade loops 2-3 hops, adjacent to sector 305',
        'Prioritize NS (Neuro-Symbolics) routes for highest margin',
        'When warp power drops to 50 or below, return to sector 305 and recharge_warp_power before trading again',
        'Never engage combat — flee if attacked'
      ],
      intervalSec: 30,
      nudgeAfterIdleSec: 270,
      abortWhen: [],
      stopWhen: []
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
