import React, { useRef, useState } from 'react';
import { Tag } from 'lucide-react';

const ROLES = [
  { value: 'refueler', label: 'Refueler', suffix: 'Refueler', color: 'text-amber-300' },
  { value: 'explorer', label: 'Explorer', suffix: 'Explorer', color: 'text-cyan-300' },
  { value: 'scavenger', label: 'Scavenger', suffix: 'Scavenger', color: 'text-emerald-300' }
];

const detectRole = (name = '') => {
  const n = name.toUpperCase();
  if (/REFUELER|TANKER|FUEL[- ]?SHIP/.test(n)) return 'refueler';
  if (/EXPLORER|SCOUT|PATHFINDER/.test(n)) return 'explorer';
  if (/SCAVENGER|SALVAGER/.test(n)) return 'scavenger';
  return null;
};

// Build a suggested rename target based on the ship's base class + role suffix.
// Example: "Autonomous Probe" + refueler → "Probe Refueler".
// We keep the last meaningful class word so the user can see what kind of hull it is.
const suggestName = (ship, role) => {
  const parts = ship.name.trim().split(/\s+/);
  const baseWord = parts.find((w) => /probe|hauler|freighter|lifter|kestrel|sparrow/i.test(w))
    || parts[parts.length - 1];
  const suffix = ROLES.find((r) => r.value === role)?.suffix || '';
  return suffix ? `${baseWord} ${suffix}` : ship.name;
};

export const ShipRoles = ({ ships }) => {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [draft, setDraft] = useState({});
  const [pending, setPending] = useState(null); // ship.name awaiting confirm-click
  const pendingTimer = useRef(null);

  const corpProbes = (ships || []).filter((s) => !s.primary && /probe/i.test(s.name || ''));

  const clearPending = () => {
    setPending(null);
    if (pendingTimer.current) { clearTimeout(pendingTimer.current); pendingTimer.current = null; }
  };

  const armPending = (shipName) => {
    setPending(shipName);
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => setPending(null), 5000);
  };

  const applyRole = async (ship, role) => {
    const newName = suggestName(ship, role);
    // First click arms the confirm; second click within 5s fires. Avoids
    // window.confirm (banned by project convention) and the focus-loss bug
    // where native dialogs auto-dismiss.
    if (pending !== ship.name) {
      armPending(ship.name);
      return;
    }
    clearPending();
    setBusy(ship.name);
    setMsg(`sending rename…`);
    const r = await fetch('/api/fleet/rename-ship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ship: ship.name, newName })
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    setBusy(null);
    setMsg(r.ok ? `rename sent: ${ship.name} → ${newName} (agent may take a moment)` : `failed: ${r.error || 'unknown'}`);
    setTimeout(() => setMsg(null), 8000);
  };

  if (corpProbes.length === 0) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400">
          <Tag className="w-3 h-3" /> Probe roles
        </div>
        <div className="text-[11px] text-slate-500">No corp probes detected.</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400">
        <Tag className="w-3 h-3" /> Probe roles
      </div>
      <div className="text-[10px] text-slate-500 -mt-1">
        Naming convention: <span className="text-amber-300">…Refueler</span>,{' '}
        <span className="text-cyan-300">…Explorer</span>,{' '}
        <span className="text-emerald-300">…Scavenger</span>. Autopilot reads
        these names and dispatches accordingly.
      </div>
      <div className="space-y-1.5">
        {corpProbes.map((p) => {
          const currentRole = detectRole(p.name);
          const selected = draft[p.name] ?? currentRole ?? '';
          return (
            <div key={p.name} className="rounded border border-slate-800 bg-slate-950/40 p-2">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[11px] font-semibold text-slate-100 truncate">{p.name}</span>
                {currentRole ? (
                  <span className={`text-[9px] uppercase px-1 rounded bg-slate-900 ${ROLES.find((r) => r.value === currentRole)?.color}`}>
                    {currentRole}
                  </span>
                ) : (
                  <span className="text-[9px] uppercase text-slate-600">unassigned</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <select
                  value={selected}
                  onChange={(e) => setDraft({ ...draft, [p.name]: e.target.value })}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded px-1 py-0.5 text-[11px] text-slate-200"
                >
                  <option value="">— pick a role —</option>
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => applyRole(p, selected)}
                  disabled={!selected || selected === currentRole || busy === p.name}
                  className={`px-2 py-0.5 rounded text-white text-[11px] disabled:bg-slate-800 disabled:text-slate-600 ${
                    pending === p.name
                      ? 'bg-amber-600 hover:bg-amber-500'
                      : 'bg-cyan-700 hover:bg-cyan-600'
                  }`}
                >
                  {busy === p.name ? '…' : pending === p.name ? 'Confirm?' : 'Rename'}
                </button>
              </div>
              {selected && selected !== currentRole ? (
                <div className="text-[10px] text-slate-500 mt-1">
                  will rename to: <span className="text-slate-300">{suggestName(p, selected)}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {msg ? <div className="text-[11px] text-slate-400">{msg}</div> : null}
    </div>
  );
};
