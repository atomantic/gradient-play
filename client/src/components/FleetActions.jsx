import React, { useState } from 'react';
import { Fuel } from 'lucide-react';

export const FleetActions = () => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const recallRefuel = async () => {
    if (!confirm('Recall ALL ships to a safe megaport and refuel them?')) return;
    setBusy(true);
    setMsg('sending recall order…');
    const r = await fetch('/api/fleet/recall-refuel', { method: 'POST' }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    setMsg(r.ok
      ? `order sent — ${r.shipCount} ships targeted`
      : `failed: ${r.error || r.send?.error || 'unknown'}`);
    setTimeout(() => setMsg(null), 8000);
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
      <div className="text-xs uppercase tracking-wider text-slate-400">Fleet actions</div>
      <button onClick={recallRefuel} disabled={busy}
        className="w-full px-3 py-2 rounded bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white text-sm flex items-center justify-center gap-2">
        <Fuel className="w-4 h-4" />
        {busy ? 'sending…' : 'Recall & refuel fleet'}
      </button>
      {msg ? <div className="text-[11px] text-slate-400">{msg}</div> : null}
      <div className="text-[10px] text-slate-500">
        One-shot order: pause active tasks, route every ship to a safe megaport,
        top off warp, then stand by. Routes around known hostile sectors.
      </div>
    </div>
  );
};
