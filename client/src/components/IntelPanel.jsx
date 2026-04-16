import React, { useEffect, useRef, useState } from 'react';
import { Skull, MapPin, UserX, Plus, Trash2, RefreshCcw, Edit2, Search } from 'lucide-react';

const eventColor = (type) => {
  if (/destroy|destroyed/i.test(type)) return 'text-rose-400';
  if (/attack/i.test(type)) return 'text-amber-300';
  if (/vanish/i.test(type)) return 'text-rose-300';
  return 'text-slate-300';
};

const fmtTs = (ms) => new Date(ms).toLocaleString('en-US', { hour12: false });

export const IntelPanel = () => {
  const [data, setData] = useState({ events: [], players: [], sectors: [] });
  const [form, setForm] = useState({ type: 'destroyed', ship: '', attacker: '', sector: '', note: '' });
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [queryMsg, setQueryMsg] = useState(null);
  const [clearArmed, setClearArmed] = useState(false);
  const clearTimer = useRef(null);

  const refresh = async () => {
    const r = await fetch('/api/intel').then((r) => r.json());
    setData(r);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, []);

  const rescan = async () => {
    await fetch('/api/intel/scan', { method: 'POST' });
    await refresh();
  };

  const addEvent = async () => {
    await fetch('/api/intel/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        sector: form.sector ? Number(form.sector) : null
      })
    });
    setForm({ type: 'destroyed', ship: '', attacker: '', sector: '', note: '' });
    setAdding(false);
    await refresh();
  };

  const deleteEvent = async (id) => {
    await fetch(`/api/intel/events/${id}`, { method: 'DELETE' });
    await refresh();
  };

  const clearAll = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setClearArmed(false), 5000);
      return;
    }
    if (clearTimer.current) { clearTimeout(clearTimer.current); clearTimer.current = null; }
    setClearArmed(false);
    await fetch('/api/intel', { method: 'DELETE' });
    await refresh();
  };

  const queryAttackers = async () => {
    const destroyedShips = [...new Set(data.events
      .filter((e) => /destroy/i.test(e.type) && e.ship && !e.attacker)
      .map((e) => e.ship))];
    if (destroyedShips.length === 0) {
      setQueryMsg('no unidentified destructions to ask about');
      return;
    }
    setQueryMsg('asking agent…');
    const r = await fetch('/api/intel/query-attackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ships: destroyedShips })
    }).then((r) => r.json());
    setQueryMsg(r.ok ? `asked agent — check chat and fill in attackers manually` : `failed: ${r.send?.error}`);
  };

  const saveEdit = async (id) => {
    await fetch(`/api/intel/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attacker: editForm.attacker || null,
        sector: editForm.sector ? Number(editForm.sector) : null,
        note: editForm.note || null
      })
    });
    setEditingId(null);
    await refresh();
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
        <div className="flex items-center gap-2">
          <Skull className="w-4 h-4 text-rose-400" />
          <div className="text-xs uppercase tracking-wider text-slate-300 font-semibold">Threat intel</div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={rescan}
            className="p-1 rounded border border-slate-700 hover:border-cyan-500 text-slate-400" title="Rescan DOM now">
            <RefreshCcw className="w-3 h-3" />
          </button>
          <button onClick={queryAttackers}
            className="p-1 rounded border border-slate-700 hover:border-amber-500 text-amber-300" title="Ask agent to identify attackers">
            <Search className="w-3 h-3" />
          </button>
          <button onClick={() => setAdding((v) => !v)}
            className="px-2 py-1 rounded border border-slate-700 hover:border-cyan-500 text-xs flex items-center gap-1">
            <Plus className="w-3 h-3" /> Log
          </button>
          <button onClick={clearAll}
            className={`px-2 py-1 rounded text-xs border ${clearArmed ? 'border-rose-500 text-rose-300 animate-pulse' : 'border-rose-900 hover:border-rose-500 text-rose-300'}`}
            title={clearArmed ? 'Click again within 5s to confirm' : 'Clear all intel'}>
            {clearArmed ? 'Confirm?' : 'Clear'}
          </button>
        </div>
      </div>
      {queryMsg ? <div className="text-[11px] text-amber-300 mb-2">{queryMsg}</div> : null}

      {adding ? (
        <div className="text-[11px] space-y-1 mb-2 p-2 rounded border border-slate-800 bg-slate-950">
          <div className="grid grid-cols-2 gap-1">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5">
              <option value="destroyed">destroyed</option>
              <option value="attacked">attacked</option>
              <option value="sighted">sighted</option>
              <option value="manual">manual</option>
            </select>
            <input value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}
              placeholder="sector"
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5" />
            <input value={form.ship} onChange={(e) => setForm({ ...form, ship: e.target.value })}
              placeholder="our ship"
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 col-span-2" />
            <input value={form.attacker} onChange={(e) => setForm({ ...form, attacker: e.target.value })}
              placeholder="attacker player name"
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 col-span-2" />
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="note (optional)"
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 col-span-2" />
          </div>
          <div className="flex items-center gap-1 pt-1">
            <button onClick={addEvent}
              className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs">Log event</button>
            <button onClick={() => setAdding(false)}
              className="px-2 py-1 rounded border border-slate-700 text-xs">Cancel</button>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 mb-2 text-[11px]">
        <div className="rounded border border-slate-800 p-2">
          <div className="flex items-center gap-1 text-slate-400 text-[10px] uppercase tracking-wider mb-1">
            <UserX className="w-3 h-3" /> Hostile players
          </div>
          {data.players.length === 0 ? (
            <div className="text-slate-600">none logged</div>
          ) : data.players.map((p) => (
            <div key={p.name} className="flex items-center gap-2 py-0.5">
              <span className="text-rose-300 font-mono flex-1 truncate">{p.name}</span>
              <span className="text-slate-500">×{p.events}</span>
              <span className="text-slate-600 text-[9px]">
                sec: {(p.sectors || []).slice(0, 3).join(', ') || '—'}
              </span>
            </div>
          ))}
        </div>
        <div className="rounded border border-slate-800 p-2">
          <div className="flex items-center gap-1 text-slate-400 text-[10px] uppercase tracking-wider mb-1">
            <MapPin className="w-3 h-3" /> Dangerous sectors
          </div>
          {data.sectors.length === 0 ? (
            <div className="text-slate-600">none logged</div>
          ) : data.sectors.map((s) => (
            <div key={s.sector} className="flex items-center gap-2 py-0.5">
              <span className="text-amber-300 font-mono">{s.sector}</span>
              <span className="text-slate-500">×{s.events}</span>
              <span className="text-slate-600 text-[9px] truncate flex-1">
                {(s.attackers || []).slice(0, 2).join(', ') || s.lastType || ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto border border-slate-800 rounded">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900/90 px-2 py-1 border-b border-slate-800">
          events ({data.events.length})
        </div>
        {data.events.length === 0 ? (
          <div className="text-xs text-slate-500 text-center py-8">No events logged yet.</div>
        ) : (
          <ul className="divide-y divide-slate-800">
            {data.events.map((e) => editingId === e.id ? (
              <li key={e.id} className="px-2 py-1.5 text-[11px] bg-slate-950">
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-slate-500 w-28 shrink-0 font-mono">{e.ship}</span>
                  <input value={editForm.attacker || ''} onChange={(e) => setEditForm({ ...editForm, attacker: e.target.value })}
                    placeholder="attacker" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5 flex-1" />
                  <input value={editForm.sector || ''} onChange={(e) => setEditForm({ ...editForm, sector: e.target.value })}
                    placeholder="sector" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5 w-16" />
                </div>
                <input value={editForm.note || ''} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })}
                  placeholder="note" className="w-full bg-slate-900 border border-slate-800 rounded px-1 py-0.5 mb-1" />
                <div className="flex items-center gap-1">
                  <button onClick={() => saveEdit(e.id)}
                    className="px-2 py-0.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white">Save</button>
                  <button onClick={() => setEditingId(null)}
                    className="px-2 py-0.5 rounded border border-slate-700">Cancel</button>
                </div>
              </li>
            ) : (
              <li key={e.id} className="px-2 py-1.5 text-[11px] flex gap-2">
                <span className="text-slate-600 w-28 shrink-0 font-mono">{fmtTs(e.ts)}</span>
                <span className={`${eventColor(e.type)} uppercase w-20 shrink-0`}>{e.type}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-slate-200 truncate">
                    {e.ship ? <span className="text-slate-100 font-mono mr-1">{e.ship}</span> : null}
                    {e.attacker ? <span className="text-rose-300 mr-1">by {e.attacker}</span> : null}
                    {e.sector != null ? <span className="text-amber-300 mr-1">@{e.sector}</span> : null}
                    {e.destroyedAgo ? <span className="text-slate-500 text-[10px] mr-1">({e.destroyedAgo})</span> : null}
                    <span className="text-slate-500 text-[10px]">[{e.source}]</span>
                  </div>
                  {e.note ? <div className="text-slate-500 text-[10px] truncate">{e.note}</div> : null}
                  {e.snippet ? <div className="text-slate-600 text-[10px] truncate">{e.snippet}</div> : null}
                </div>
                <button onClick={() => { setEditingId(e.id); setEditForm({ attacker: e.attacker || '', sector: e.sector != null ? String(e.sector) : '', note: e.note || '' }); }}
                  className="text-slate-600 hover:text-cyan-400 shrink-0">
                  <Edit2 className="w-3 h-3" />
                </button>
                <button onClick={() => deleteEvent(e.id)}
                  className="text-slate-600 hover:text-rose-400 shrink-0">
                  <Trash2 className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
