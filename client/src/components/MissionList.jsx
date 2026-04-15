import React from 'react';
import { Square } from 'lucide-react';

const statusColor = (s) => ({
  running: 'text-emerald-400 border-emerald-700',
  aborted: 'text-rose-300 border-rose-800',
  completed: 'text-cyan-300 border-cyan-800'
}[s] || 'text-slate-400 border-slate-700');

export const MissionList = ({ missions, selectedId, onSelect, onAbort }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
    <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Missions</div>
    {missions.length === 0 ? (
      <div className="text-xs text-slate-500">No missions yet.</div>
    ) : (
      <ul className="space-y-1">
        {missions.map((m) => (
          <li key={m.id}
            onClick={() => onSelect(m.id)}
            className={`cursor-pointer rounded px-2 py-2 border ${selectedId === m.id ? 'border-cyan-700 bg-cyan-950/30' : 'border-slate-800 hover:border-slate-700'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[10px] uppercase tracking-wider px-1 py-0.5 rounded border ${statusColor(m.status)}`}>
                {m.status}
              </span>
              <span className="text-[10px] text-slate-500">tick {m.tickCount}</span>
              {m.status === 'running' ? (
                <button onClick={(e) => { e.stopPropagation(); onAbort(m.id); }}
                  className="text-slate-500 hover:text-rose-400" title="Abort">
                  <Square className="w-3 h-3" />
                </button>
              ) : null}
            </div>
            {m.spec.targetShip ? (
              <div className="text-[10px] text-cyan-400 mt-0.5 font-mono truncate">→ {m.spec.targetShip}</div>
            ) : null}
            <div className="text-xs text-slate-200 mt-1 line-clamp-2">{m.spec.goal}</div>
          </li>
        ))}
      </ul>
    )}
  </div>
);
