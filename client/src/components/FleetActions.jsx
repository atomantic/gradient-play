import React, { useRef, useState } from 'react';
import { Fuel, Flag } from 'lucide-react';

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

  const doAction = async (action, url) => {
    if (pending !== action) { armPending(action); return; }
    clearPending();
    setBusy(action);
    setMsg('sending…');
    const r = await fetch(url, { method: 'POST' }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    setBusy(null);
    setMsg(r.ok
      ? `${action} started — ${r.shipCount ?? '?'} ships`
      : `failed: ${r.error || 'unknown'}`);
    setTimeout(() => setMsg(null), 8000);
  };

  const btnClass = (action, base) =>
    `w-full px-3 py-2 rounded text-white text-sm flex items-center justify-center gap-2 disabled:bg-slate-700 ${
      pending === action ? 'bg-amber-600 hover:bg-amber-500' : base
    }`;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
      <div className="text-xs uppercase tracking-wider text-slate-400">Fleet actions</div>

      <button onClick={() => doAction('recall', '/api/fleet/recall-refuel')}
        disabled={busy != null}
        className={btnClass('recall', 'bg-slate-700 hover:bg-slate-600')}>
        <Fuel className="w-4 h-4" />
        {busy === 'recall' ? 'sending…' : pending === 'recall' ? 'Confirm recall?' : 'Quick recall & refuel'}
      </button>

      <button onClick={() => doAction('rally', '/api/fleet/rally')}
        disabled={busy != null}
        className={btnClass('rally', 'bg-cyan-700 hover:bg-cyan-600')}>
        <Flag className="w-4 h-4" />
        {busy === 'rally' ? 'sending…' : pending === 'rally' ? 'Confirm rally?' : 'Rally, refuel & bank'}
      </button>

      {msg ? <div className="text-[11px] text-slate-400">{msg}</div> : null}
      <div className="text-[10px] text-slate-500">
        <strong>Quick recall:</strong> one-shot prompt — everyone to a megaport.<br/>
        <strong>Rally:</strong> coordinated 5-step plan — fuel-share → converge →
        recharge → sweep credits → resume. Runs through autopilot plan queue.
      </div>
    </div>
  );
};
