import React, { useEffect, useRef, useState } from 'react';
import { Bot, Play, Square, Settings } from 'lucide-react';

const DEFAULT_CONFIG = {
  pollIntervalSec: 60,
  minWarp: 50,
  fuelCriticalWarp: 15,
  refuelCooldownSec: 180,
  rescueCooldownSec: 90,
  safeMode: true,
  isCeo: false,
  troubleMaker: false,
  maxDecisionsPerTick: 2,
  homeHub: 1413,
  dispatchMinWarp: 200,
  onHandFloor: 5000,
  depositExcessOver: 5000,
  decisionCooldownSec: 420,
  considerUpgrades: true,
  upgradeCreditsThreshold: 100000,
  corpTaskCap: 3,
  primaryDispatchCooldownSec: 300,
  enabled: { refuel: true, explore: true, trade: true, bank: true, upgrade: true, primary: true }
};

const entryColor = (type) => ({
  decision: 'text-cyan-300',
  event: 'text-amber-300',
  plan: 'text-violet-300',
  tick: 'text-slate-500',
  start: 'text-emerald-400',
  stop: 'text-amber-400',
  error: 'text-rose-300'
}[type] || 'text-slate-400');

const formatEntry = (e) => {
  if (e.type === 'tick') {
    const s = e.snapshot;
    if (!s) return 'poll (no snapshot)';
    const running = s.tasksRunning ?? 0;
    const ships = (s.ships || []).map((sh) => `${sh.name.split(' ').pop()}:${sh.warp ?? '-'}${sh.active ? '●' : '○'}`).join(' ');
    const cap = e.capped ? ` corpTasks=${s.corpActive}/${s.corpTaskCap} CAPPED` : (s.corpActive != null ? ` corp=${s.corpActive}/${s.corpTaskCap}` : '');
    const slots = s.taskSlots ? ` slots=${s.taskSlots}` : '';
    return `poll  tasks=${running}${slots}${cap}  bank=${s.creditsBank}  hand=${s.creditsOnHand}  [${ships}]  decisions=${e.decisionCount}`;
  }
  if (e.type === 'plan') {
    const tag = e.shipName ? `[${e.shipName.split(' ').pop()}] ` : '';
    if (e.event === 'create') return `${tag}plan:${e.goal} created (${e.stepCount} steps) → ${e.step}`;
    if (e.event === 'advance') return `${tag}plan:${e.goal} advance from "${e.fromStep}" (${e.reason})`;
    if (e.event === 'complete') return `${tag}plan:${e.goal} complete`;
    if (e.event === 'prompt') return `${tag}plan:${e.goal} → ${e.step}: ${e.text}`;
    if (e.event === 'nag') return `${tag}plan:${e.goal} nag "${e.step}"`;
    return `${tag}plan:${e.goal} ${e.event}`;
  }
  if (e.type === 'decision') return (e.ship ? `[${e.ship.split(' ').pop()}] ` : '') + e.text;
  if (e.type === 'event' && e.intelType) return `[${e.ship?.split(' ').pop() || '?'}] intel: ${e.intelType}${e.attacker ? ' by ' + e.attacker : ''}${e.sector ? ' @' + e.sector : ''}`;
  if (e.type === 'event') return `[${e.ship?.split(' ').pop() || '?'}] ${e.snippet || ''} — cooldown cleared`;
  if (e.intelType === 'cap-hit' || e.type === 'cap-hit') return `corp task cap hit — holding off on new trade/explore until a slot frees`;
  if (e.type === 'error') return 'error: ' + e.error;
  if (e.type === 'start') return 'autopilot started';
  if (e.type === 'stop') return 'autopilot stopped';
  return JSON.stringify(e);
};

const STORAGE_ENABLED = 'autopilot.enabled';
// Bumped to v2 when the credit floor was raised from 1000→5000. Old stored
// configs had stale 1000 / 3000 values that caused the sweep prompt to tell
// the agent "keep 1000 on hand", triggering banking well below intent.
const STORAGE_CONFIG = 'autopilot.config.v2';

const loadStoredConfig = () => {
  const raw = localStorage.getItem(STORAGE_CONFIG);
  if (!raw) {
    // One-time cleanup: drop the legacy key so it doesn't linger in storage.
    try { localStorage.removeItem('autopilot.config'); } catch {}
    return DEFAULT_CONFIG;
  }
  const parsed = JSON.parse(raw);
  return { ...DEFAULT_CONFIG, ...parsed, enabled: { ...DEFAULT_CONFIG.enabled, ...(parsed.enabled || {}) } };
};

export const AutopilotPanel = () => {
  const [state, setState] = useState(null);
  const [config, setConfig] = useState(loadStoredConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [entries, setEntries] = useState([]);
  const scrollRef = useRef(null);
  const autoStartTriedRef = useRef(false);
  const lastAutoStartAtRef = useRef(0);

  const refresh = async () => {
    const s = await fetch('/api/autopilot').then((r) => r.json());
    setState(s);
    if (s.config) setConfig({ ...DEFAULT_CONFIG, ...s.config, enabled: { ...DEFAULT_CONFIG.enabled, ...(s.config.enabled || {}) } });
    if (s.log) setEntries(s.log);
    return s;
  };

  // If localStorage says autopilot should be running but server says it isn't,
  // restart it. Throttled so we don't hammer the server when something keeps
  // failing.
  const maybeAutoStart = async (serverState) => {
    if (localStorage.getItem(STORAGE_ENABLED) !== 'true') return;
    if (serverState?.running) return;
    if (Date.now() - lastAutoStartAtRef.current < 20_000) return;
    lastAutoStartAtRef.current = Date.now();
    const cfg = loadStoredConfig();
    await fetch('/api/autopilot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    }).catch(() => { /* will retry */ });
    await refresh();
  };

  useEffect(() => {
    (async () => {
      const s = await refresh();
      if (!autoStartTriedRef.current) {
        autoStartTriedRef.current = true;
        await maybeAutoStart(s);
      }
    })();
    const es = new EventSource('/api/autopilot/stream');
    es.addEventListener('snapshot', (e) => {
      const s = JSON.parse(e.data);
      if (s.log) setEntries(s.log);
    });
    es.addEventListener('log', (e) => {
      setEntries((prev) => [...prev, JSON.parse(e.data)].slice(-400));
    });
    const poll = setInterval(async () => {
      const s = await refresh();
      maybeAutoStart(s);
    }, 10_000);
    return () => { es.close(); clearInterval(poll); };
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries]);

  const start = async () => {
    localStorage.setItem(STORAGE_ENABLED, 'true');
    localStorage.setItem(STORAGE_CONFIG, JSON.stringify(config));
    lastAutoStartAtRef.current = Date.now();
    await fetch('/api/autopilot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    await refresh();
  };

  const stop = async () => {
    localStorage.setItem(STORAGE_ENABLED, 'false');
    await fetch('/api/autopilot/stop', { method: 'POST' });
    await refresh();
  };

  const running = state?.running;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
        <div className="flex items-center gap-2">
          <Bot className={`w-4 h-4 ${running ? 'text-emerald-400' : 'text-slate-500'}`} />
          <div className="text-xs uppercase tracking-wider text-slate-300 font-semibold">Autopilot</div>
          {running ? (
            <span className="text-[10px] uppercase tracking-wider text-emerald-400 bg-emerald-950/60 px-1 rounded">running</span>
          ) : (
            <span className="text-[10px] uppercase tracking-wider text-slate-500">idle</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowConfig((v) => !v)}
            className="p-1 rounded border border-slate-700 hover:border-cyan-500 text-slate-400">
            <Settings className="w-3 h-3" />
          </button>
          {running ? (
            <button onClick={stop}
              className="px-2 py-1 rounded border border-rose-900 hover:border-rose-500 text-rose-300 text-xs flex items-center gap-1">
              <Square className="w-3 h-3" /> Stop
            </button>
          ) : (
            <button onClick={start}
              className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs flex items-center gap-1">
              <Play className="w-3 h-3" /> Start
            </button>
          )}
        </div>
      </div>

      {showConfig ? (
        <div className="text-[11px] space-y-2 mb-2 p-2 rounded border border-slate-800 bg-slate-950">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Poll every</span>
              <input type="number" min={15} value={config.pollIntervalSec}
                onChange={(e) => setConfig({ ...config, pollIntervalSec: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16" /> s
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Cooldown</span>
              <input type="number" min={60} value={config.decisionCooldownSec}
                onChange={(e) => setConfig({ ...config, decisionCooldownSec: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16" /> s
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Home hub</span>
              <input type="number" min={0} value={config.homeHub ?? 305}
                onChange={(e) => setConfig({ ...config, homeHub: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Min warp</span>
              <input type="number" min={0} value={config.minWarp}
                onChange={(e) => setConfig({ ...config, minWarp: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Dispatch min</span>
              <input type="number" min={0} value={config.dispatchMinWarp ?? 200}
                onChange={(e) => setConfig({ ...config, dispatchMinWarp: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Rescue at</span>
              <input type="number" min={0} value={config.fuelCriticalWarp}
                onChange={(e) => setConfig({ ...config, fuelCriticalWarp: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">On-hand floor</span>
              <input type="number" min={0} value={config.onHandFloor}
                onChange={(e) => setConfig({ ...config, onHandFloor: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-20" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Sweep above</span>
              <input type="number" min={0} value={config.depositExcessOver}
                onChange={(e) => setConfig({ ...config, depositExcessOver: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-20" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Upgrade at</span>
              <input type="number" min={0} value={config.upgradeCreditsThreshold}
                onChange={(e) => setConfig({ ...config, upgradeCreditsThreshold: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-20" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-400 w-24">Corp task cap</span>
              <input type="number" min={1} max={10} value={config.corpTaskCap}
                onChange={(e) => setConfig({ ...config, corpTaskCap: Number(e.target.value) })}
                className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16" />
            </label>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
            <label className="flex items-center gap-1 text-amber-300 font-semibold">
              <input type="checkbox" checked={config.safeMode ?? true}
                onChange={(e) => setConfig({ ...config, safeMode: e.target.checked })} />
              safe mode
            </label>
            <label className="flex items-center gap-1 text-rose-300 font-semibold">
              <input type="checkbox" checked={config.isCeo ?? false}
                onChange={(e) => setConfig({ ...config, isCeo: e.target.checked })} />
              I am CEO
            </label>
            <label className="flex items-center gap-1 text-fuchsia-300 font-semibold">
              <input type="checkbox" checked={config.troubleMaker ?? false}
                onChange={(e) => setConfig({ ...config, troubleMaker: e.target.checked })} />
              troublemaker
            </label>
            {Object.keys(config.enabled).map((k) => (
              <label key={k} className="flex items-center gap-1 text-slate-400">
                <input type="checkbox" checked={config.enabled[k]}
                  onChange={(e) => setConfig({ ...config, enabled: { ...config.enabled, [k]: e.target.checked } })} />
                {k}
              </label>
            ))}
          </div>
          <div className="text-[10px] text-amber-400/70 -mt-0.5">
            Safe mode: non-probe ships stay in federation space. Probes may venture further.
          </div>
          <div className="text-[10px] text-rose-400/70 -mt-0.5">
            CEO: autopilot manages every corp ship (shared task slots). Off = primary ship only — prevents colliding with other corp members' dispatches.
          </div>
          <div className="text-[10px] text-fuchsia-400/70 -mt-0.5">
            Troublemaker: primary leaves fedspace, hunts salvage, engages combat, trades only for fuel. Banks down to 1,000 on-hand before each run; refuels at home hub between runs.
          </div>
          <div className="text-slate-500 text-[10px]">
            Changes take effect on next Start. Stop + Start to apply.
          </div>
        </div>
      ) : null}

      {state?.plans?.length ? (
        <div className="mb-2 p-2 rounded border border-violet-900/60 bg-violet-950/20 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-violet-300">Active plans</div>
          {state.plans.map((p) => {
            const step = p.steps[p.currentStep];
            const stepAgeSec = Math.floor((Date.now() - p.stepStartedAt) / 1000);
            return (
              <div key={p.id} className="text-[11px] flex items-center gap-2 font-mono">
                <span className="text-violet-200 font-semibold">{p.ship}</span>
                <span className="text-slate-500">/</span>
                <span className="text-slate-300">{p.goal}</span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-400">
                  step {p.currentStep + 1}/{p.steps.length}:{' '}
                  <span className="text-violet-300">{step?.name || '—'}</span>
                </span>
                <span className="text-slate-600 ml-auto">{stepAgeSec}s</span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[11px] space-y-1 min-h-[200px]">
        {entries.length === 0 ? (
          <div className="text-slate-500 text-center py-8">Start autopilot to see decision log</div>
        ) : entries.map((e, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-slate-600 w-20 shrink-0">
              {new Date(e.ts).toLocaleTimeString('en-US', { hour12: false })}
            </span>
            <span className={`${entryColor(e.type)} uppercase w-16 shrink-0`}>{e.type}</span>
            <span className="text-slate-300 whitespace-pre-wrap break-words flex-1">{formatEntry(e)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
