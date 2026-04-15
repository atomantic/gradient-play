import React, { useEffect, useRef, useState } from 'react';
import { api, streamMission } from '../api.js';
import { Square, X } from 'lucide-react';

const entryColor = (type) => ({
  kickoff: 'text-cyan-300',
  nudge: 'text-amber-300',
  tick: 'text-slate-500',
  start: 'text-emerald-400',
  stop: 'text-cyan-400',
  abort: 'text-rose-400',
  error: 'text-rose-300'
}[type] || 'text-slate-400');

const formatEntry = (e) => {
  if (e.type === 'kickoff' || e.type === 'nudge') return e.text;
  if (e.type === 'tick') {
    const s = e.snapshot || {};
    const bits = [];
    if (s.sector != null) bits.push(`sec=${s.sector}`);
    if (s.warpPower != null) bits.push(`warp=${s.warpPower}`);
    if (s.creditsOnHand != null) bits.push(`cred=${s.creditsOnHand}`);
    if (e.tasksWorking) bits.push(`engine=on`);
    if (e.activity?.length) bits.push(`active[${e.activity.join(',')}]`);
    else if (e.idleSec != null) bits.push(`idle=${e.idleSec}s`);
    return 'poll ' + bits.join(' · ');
  }
  if (e.type === 'error') return 'error: ' + e.error;
  if (e.type === 'abort' || e.type === 'stop') return `${e.type}: ${e.reason || ''}  ${e.prompt ? '→ ' + e.prompt.slice(0, 120) : ''}`;
  return JSON.stringify(e);
};

export const MissionDetail = ({ missionId, onAbort, onUntrack }) => {
  const [mission, setMission] = useState(null);
  const [entries, setEntries] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!missionId) {
      setMission(null);
      setEntries([]);
      return;
    }
    let cancelled = false;
    api.mission(missionId).then((m) => {
      if (cancelled) return;
      setMission(m);
      setEntries(m.log || []);
    }).catch(() => {});
    const close = streamMission(missionId, {
      onLog: (e) => setEntries((prev) => [...prev, e].slice(-400))
    });
    return () => { cancelled = true; close(); };
  }, [missionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  if (!missionId) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 h-full flex items-center justify-center text-slate-500 text-sm">
        Select a mission to view its live log.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col h-[calc(100vh-120px)]">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
        <div>
          <div className="text-xs text-slate-500">mission</div>
          <div className="text-sm text-slate-100 font-mono">{missionId.slice(0, 8)}…</div>
        </div>
        <div className="flex items-center gap-1">
          {mission?.status === 'running' ? (
            <button onClick={() => onAbort(missionId)}
              className="px-2 py-1 rounded border border-rose-800 hover:border-rose-500 text-rose-300 text-xs flex items-center gap-1"
              title="Sends a stand-down prompt to the game agent, then stops tracking">
              <Square className="w-3 h-3" /> Abort
            </button>
          ) : (
            <span className="text-xs text-slate-500 mr-2">{mission?.status}</span>
          )}
          <button onClick={() => onUntrack(missionId)}
            className="px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400 text-xs flex items-center gap-1"
            title="Remove from tracking without messaging the game agent">
            <X className="w-3 h-3" /> Untrack
          </button>
        </div>
      </div>
      {mission?.spec?.goal ? (
        <div className="text-xs text-slate-300 mb-2 whitespace-pre-wrap">{mission.spec.goal}</div>
      ) : null}
      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[11px] space-y-1">
        {entries.map((e, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-slate-600 w-20 shrink-0">
              {new Date(e.ts).toLocaleTimeString('en-US', { hour12: false })}
            </span>
            <span className={`${entryColor(e.type)} uppercase w-14 shrink-0`}>{e.type}</span>
            <span className="text-slate-300 whitespace-pre-wrap break-words flex-1">{formatEntry(e)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
