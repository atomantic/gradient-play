import React, { useState } from 'react';
import { Plus, Save, Trash2, RotateCcw, FileEdit } from 'lucide-react';

const METRICS = ['warpPower', 'credits', 'creditsOnHand', 'creditsBank', 'fighters', 'shields', 'cargo', 'sector'];
const OPS = ['<', '<=', '>', '>=', '=='];

const emptySpec = () => ({
  goal: '',
  targetShip: '',
  guardrails: [],
  intervalSec: 30,
  nudgeAfterIdleSec: 270,
  abortWhen: [],
  stopWhen: [],
  maxTicks: 0
});

const ConditionEditor = ({ label, list, onChange }) => {
  const addRow = () => onChange([...list, { metric: 'warpPower', op: '<', value: 50 }]);
  const updateRow = (i, patch) => onChange(list.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const removeRow = (i) => onChange(list.filter((_, idx) => idx !== i));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
        <button onClick={addRow} className="text-xs text-slate-400 hover:text-cyan-300 flex items-center gap-1">
          <Plus className="w-3 h-3" /> add
        </button>
      </div>
      <div className="space-y-1">
        {list.map((r, i) => (
          <div key={i} className="flex items-center gap-1 text-xs">
            <select value={r.metric} onChange={(e) => updateRow(i, { metric: e.target.value })}
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 flex-1">
              {METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={r.op} onChange={(e) => updateRow(i, { op: e.target.value })}
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-14">
              {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input type="number" value={r.value} onChange={(e) => updateRow(i, { value: Number(e.target.value) })}
              className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-20" />
            <button onClick={() => removeRow(i)} className="text-slate-500 hover:text-rose-400">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export const MissionComposer = ({ templates = [], ships = [], onCreate, onSaveTemplate, onDeleteTemplate }) => {
  const [spec, setSpec] = useState(emptySpec());
  const [guardrailText, setGuardrailText] = useState('');
  const [saveName, setSaveName] = useState('');
  const [editing, setEditing] = useState(null); // { name, source } of loaded template

  const applyTemplate = (t) => {
    setSpec({ ...emptySpec(), ...t.spec });
    setGuardrailText((t.spec.guardrails || []).join('\n'));
    setEditing({ name: t.name, source: t.source, builtin: t.builtin });
    setSaveName(t.name);
  };

  const clearEditing = () => {
    setEditing(null);
    setSpec(emptySpec());
    setGuardrailText('');
    setSaveName('');
  };

  const buildSpec = () => ({
    ...spec,
    guardrails: guardrailText.split('\n').map((l) => l.trim()).filter(Boolean)
  });

  const create = () => {
    const built = buildSpec();
    if (!built.goal.trim()) return;
    onCreate(built);
  };

  const saveAsTemplate = async () => {
    if (!saveName.trim()) return;
    await onSaveTemplate(saveName.trim(), buildSpec());
    // If we were editing a builtin, this save created an override; refresh the marker.
    if (editing?.builtin) setEditing({ ...editing, source: 'override' });
    else if (!editing) setEditing({ name: saveName.trim(), source: 'user', builtin: false });
  };

  const resetTemplate = async () => {
    if (!editing?.name) return;
    await onDeleteTemplate(editing.name);
    // For builtins: deleting the user override restores the builtin seed.
    // For user-only templates: the template is gone; clear the composer.
    if (editing.builtin) {
      const fresh = templates.find((t) => t.name === editing.name);
      if (fresh) applyTemplate(fresh);
      else clearEditing();
    } else {
      clearEditing();
    }
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-slate-400">
          {editing ? 'Edit template' : 'New mission'}
        </div>
        <div className="flex items-center gap-1">
          <select onChange={(e) => {
            const t = templates[Number(e.target.value)];
            if (t) applyTemplate(t);
            e.target.value = '';
          }} className="bg-slate-950 border border-slate-800 rounded text-xs px-1 py-0.5">
            <option value="">load template…</option>
            {templates.map((t, i) => (
              <option key={t.name} value={i}>
                {t.name}{t.source === 'override' ? ' ✎' : t.source === 'user' ? ' •' : ''}
              </option>
            ))}
          </select>
          {editing ? (
            <button onClick={clearEditing}
              className="px-2 py-0.5 rounded border border-slate-700 hover:border-slate-500 text-[10px] text-slate-400">
              new
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="flex items-center gap-2 text-[11px] rounded border border-slate-800 bg-slate-950 px-2 py-1">
          <FileEdit className="w-3 h-3 text-cyan-400" />
          <span className="text-slate-300 truncate flex-1">
            editing: <span className="text-cyan-300 font-mono">{editing.name}</span>
          </span>
          <span className={`text-[9px] uppercase px-1 rounded ${
            editing.source === 'builtin' ? 'bg-slate-800 text-slate-400' :
            editing.source === 'override' ? 'bg-amber-950 text-amber-300' :
            'bg-cyan-950 text-cyan-300'
          }`}>
            {editing.source}
          </span>
        </div>
      ) : null}

      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Target ship</div>
        <select value={spec.targetShip || ''}
          onChange={(e) => setSpec({ ...spec, targetShip: e.target.value })}
          className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-sm">
          <option value="">— fleet-wide (no specific ship) —</option>
          {ships.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}{s.primary ? ' ★' : ''}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Goal</div>
        <textarea
          value={spec.goal}
          onChange={(e) => setSpec({ ...spec, goal: e.target.value })}
          rows={4}
          placeholder="Continue running trades until we're low enough on fuel that we have to stop at a megaport…"
          className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm resize-none focus:outline-none focus:border-cyan-600"
        />
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Guardrails (one per line)</div>
        <textarea
          value={guardrailText}
          onChange={(e) => setGuardrailText(e.target.value)}
          rows={3}
          placeholder="Never engage combat&#10;Prioritize NS commodity routes"
          className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs resize-none focus:outline-none focus:border-cyan-600"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <label className="flex items-center gap-1">
          <span className="uppercase tracking-wide text-slate-500 shrink-0">Poll every</span>
          <input type="number" min={10} value={spec.intervalSec}
            onChange={(e) => setSpec({ ...spec, intervalSec: Number(e.target.value) })}
            className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16 text-sm" />
          <span className="text-slate-500">s</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="uppercase tracking-wide text-slate-500 shrink-0">Nudge after idle</span>
          <input type="number" min={0} value={spec.nudgeAfterIdleSec}
            onChange={(e) => setSpec({ ...spec, nudgeAfterIdleSec: Number(e.target.value) })}
            className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 w-16 text-sm" />
          <span className="text-slate-500">s</span>
        </label>
      </div>
      <div className="text-[10px] text-slate-500 -mt-1">
        Poll = passive state check (no prompt). Nudge fires only if the assistant has been silent this long — default 270s sits just under the game's 5-min task timeout. Set to 0 to disable.
      </div>

      <ConditionEditor label="Abort when"
        list={spec.abortWhen}
        onChange={(abortWhen) => setSpec({ ...spec, abortWhen })} />
      <ConditionEditor label="Stop when"
        list={spec.stopWhen}
        onChange={(stopWhen) => setSpec({ ...spec, stopWhen })} />

      <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
        <button onClick={create}
          className="px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-sm">
          Launch mission
        </button>
        <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
          placeholder={editing ? 'template name' : 'save as…'}
          className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs" />
        <button onClick={saveAsTemplate}
          className="px-2 py-1 rounded border border-slate-700 hover:border-cyan-500 text-xs flex items-center gap-1"
          title={editing?.builtin && editing.source === 'builtin' ? 'Save as override' : 'Save template'}>
          <Save className="w-3 h-3" /> {editing?.builtin && editing.source === 'builtin' ? 'override' : 'save'}
        </button>
        {editing && (editing.source === 'override' || editing.source === 'user') ? (
          <button onClick={resetTemplate}
            className="px-2 py-1 rounded border border-rose-900 hover:border-rose-500 text-rose-300 text-xs flex items-center gap-1"
            title={editing.builtin ? 'Reset to built-in' : 'Delete template'}>
            {editing.builtin ? <RotateCcw className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
          </button>
        ) : null}
      </div>
    </div>
  );
};
