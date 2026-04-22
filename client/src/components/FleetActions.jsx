import React, { useRef, useState } from 'react';
import { Fuel, MapPin, Banknote, Zap, Scale, Briefcase, Rocket, Home, Radar } from 'lucide-react';

const STEPS = [
  { name: 'fuel-share',         label: 'Fuel Share',      icon: Fuel,      hint: 'transfer_warp between non-probe ships until everyone has enough to move' },
  { name: 'rally',              label: 'Rally to Hub',    icon: MapPin,    hint: 'plot_course non-probe ships to the home hub and dock (probes stay in the field)' },
  { name: 'fund-for-recharge',  label: 'Fund Ships',      icon: Banknote,  hint: 'primary transfers credits to any non-probe ship below 1000' },
  { name: 'recharge',           label: 'Recharge',        icon: Zap,       hint: 'recharge_warp_power on every non-probe ship to full' },
  { name: 'credit-balance',     label: 'Balance Credits', icon: Scale,     hint: 'even out credits on non-probe ships at the configured floor, primary banks excess' },
  { name: 'resume',             label: 'Dispatch Roles',  icon: Briefcase, hint: 'send non-probe ships back to their role tasks; probes keep exploring' }
];

export const FleetActions = () => {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [pending, setPending] = useState(null);
  const pendingTimer = useRef(null);

  const clearPending = () => {
    setPending(null);
    if (pendingTimer.current) { clearTimeout(pendingTimer.current); pendingTimer.current = null; }
  };
  const armPending = (action) => {
    setPending(action);
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => setPending(null), 5000);
  };

  const post = async (action, url, body) => {
    setBusy(action);
    setMsg('sending…');
    const r = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    setBusy(null);
    setMsg(r.ok ? `${action} sent` : `failed: ${r.error || 'unknown'}`);
    setTimeout(() => setMsg(null), 6000);
  };

  const fireStep = (name) => post(name, '/api/fleet/step', { step: name });

  const confirmAction = async (action, url, body) => {
    if (pending !== action) { armPending(action); return; }
    clearPending();
    await post(action, url, body);
  };

  const stepBtn = (s) => {
    const Icon = s.icon;
    return (
      <button key={s.name}
        onClick={() => fireStep(s.name)}
        disabled={busy != null}
        title={s.hint}
        className="px-3 py-2 rounded text-white text-sm flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500">
        <Icon className="w-4 h-4" />
        {busy === s.name ? 'sending…' : s.label}
      </button>
    );
  };

  const bigBtnClass = (action, base) =>
    `w-full px-3 py-2 rounded text-white text-sm flex items-center justify-center gap-2 disabled:bg-slate-700 ${
      pending === action ? 'bg-amber-600 hover:bg-amber-500' : base
    }`;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-3">
      <div className="text-xs uppercase tracking-wider text-slate-400">Fleet actions</div>

      <div className="grid grid-cols-2 gap-2">
        {STEPS.map(stepBtn)}
      </div>

      <div className="pt-1 border-t border-slate-800" />

      <button onClick={() => confirmAction('everything', '/api/fleet/rally', { resume: true })}
        disabled={busy != null}
        className={bigBtnClass('everything', 'bg-cyan-700 hover:bg-cyan-600')}>
        <Rocket className="w-4 h-4" />
        {busy === 'everything' ? 'sending…' : pending === 'everything' ? 'Confirm run everything?' : 'Everything (full rally + dispatch)'}
      </button>

      <button onClick={() => confirmAction('home-base', '/api/fleet/rally', { resume: false })}
        disabled={busy != null}
        className={bigBtnClass('home-base', 'bg-amber-700 hover:bg-amber-600')}>
        <Home className="w-4 h-4" />
        {busy === 'home-base' ? 'sending…' : pending === 'home-base' ? 'Confirm park at hub?' : 'Everything but Dispatch (park at hub)'}
      </button>

      <div className="pt-1 border-t border-slate-800" />

      <button onClick={() => post('salvage-scan', '/api/fleet/salvage-scan')}
        disabled={busy != null}
        title="Send the primary ship on a 10-hop salvage sweep — find non-empty containers, score by value/hop, salvage_collect each, repeat until the radius is clean. Probes only get credits; primary collects everything."
        className="w-full px-3 py-2 rounded text-white text-sm flex items-center justify-center gap-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700">
        <Radar className="w-4 h-4" />
        {busy === 'salvage-scan' ? 'sending…' : 'Salvage Scan (primary, 10-hop sweep)'}
      </button>

      {msg ? <div className="text-[11px] text-slate-400">{msg}</div> : null}
      <div className="text-[10px] text-slate-500">
        Step buttons fire a single prompt and stop — no plan, no nag. Run them in any order you like.
        The two big buttons chain all steps as a managed plan (double-click to confirm). Salvage Scan
        dispatches the primary on an opportunistic loot sweep — fire & forget.
      </div>
    </div>
  );
};
