import React, { useEffect, useRef, useState } from 'react';
import { Cpu, Plus, Trash2, RefreshCcw, Edit2, Play, CheckCircle2, XCircle, BookOpen } from 'lucide-react';

const req = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
};

const EMPTY_FORM = {
  name: '',
  type: 'api',
  endpoint: '',
  apiKey: '',
  command: '',
  args: '',
  models: '',
  defaultModel: '',
  lightModel: '',
  mediumModel: '',
  heavyModel: '',
  timeout: 300000,
  enabled: true
};

const toFormState = (p) => ({
  ...EMPTY_FORM,
  ...p,
  args: Array.isArray(p?.args) ? p.args.join(' ') : (p?.args || ''),
  models: Array.isArray(p?.models) ? p.models.join(', ') : (p?.models || '')
});

const toPayload = (f) => ({
  name: f.name,
  type: f.type,
  endpoint: f.type === 'api' ? f.endpoint : undefined,
  apiKey: f.type === 'api' ? (f.apiKey || undefined) : undefined,
  command: f.type === 'cli' ? f.command : undefined,
  args: f.type === 'cli' ? f.args.split(/\s+/).filter(Boolean) : undefined,
  models: f.models.split(',').map((m) => m.trim()).filter(Boolean),
  defaultModel: f.defaultModel || undefined,
  lightModel: f.lightModel || undefined,
  mediumModel: f.mediumModel || undefined,
  heavyModel: f.heavyModel || undefined,
  timeout: Number(f.timeout) || 300000,
  enabled: !!f.enabled
});

export const AIPanel = () => {
  const [providers, setProviders] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [tests, setTests] = useState({});
  const [error, setError] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [runOutput, setRunOutput] = useState('');
  const [strategyBusy, setStrategyBusy] = useState(false);
  const pollRef = useRef(null);

  const refresh = async () => {
    const r = await req('GET', '/api/ai/providers').catch(() => ({ providers: [], activeProvider: null }));
    setProviders(r.providers || []);
    setActiveId(r.activeProvider || null);
    const rs = await req('GET', '/api/ai/runs?limit=15&offset=0&source=all').catch(() => ({ runs: [] }));
    setRuns(rs.runs || []);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!selectedRun) return;
    let stopped = false;
    const poll = async () => {
      const r = await req('GET', `/api/ai/runs/${selectedRun}`).catch(() => null);
      const o = await req('GET', `/api/ai/runs/${selectedRun}/output`).catch(() => null);
      if (stopped) return;
      if (typeof o === 'string') setRunOutput(o);
      else if (o?.output != null) setRunOutput(o.output);
      if (r && (r.success === true || r.success === false)) {
        clearTimeout(pollRef.current);
        return;
      }
      pollRef.current = setTimeout(poll, 1500);
    };
    poll();
    return () => { stopped = true; clearTimeout(pollRef.current); };
  }, [selectedRun]);

  const startAdd = () => { setEditing('new'); setForm(EMPTY_FORM); };
  const startEdit = (p) => { setEditing(p.id); setForm(toFormState(p)); };
  const cancel = () => { setEditing(null); setForm(EMPTY_FORM); };

  const save = async () => {
    setError(null);
    const payload = toPayload(form);
    try {
      if (editing === 'new') await req('POST', '/api/ai/providers', payload);
      else await req('PUT', `/api/ai/providers/${editing}`, payload);
      cancel();
      await refresh();
    } catch (e) { setError(e.message); }
  };

  const del = async (id) => {
    await req('DELETE', `/api/ai/providers/${id}`).catch((e) => setError(e.message));
    await refresh();
  };

  const test = async (id) => {
    setTests((t) => ({ ...t, [id]: { testing: true } }));
    const r = await req('POST', `/api/ai/providers/${id}/test`).catch((e) => ({ success: false, error: e.message }));
    setTests((t) => ({ ...t, [id]: r }));
  };

  const setActive = async (id) => {
    await req('PUT', '/api/ai/providers/active', { id }).catch((e) => setError(e.message));
    await refresh();
  };

  const toggleEnabled = async (p) => {
    await req('PUT', `/api/ai/providers/${p.id}`, { enabled: !p.enabled }).catch((e) => setError(e.message));
    await refresh();
  };

  const refreshModels = async (id) => {
    await req('POST', `/api/ai/providers/${id}/refresh-models`).catch((e) => setError(e.message));
    await refresh();
  };

  const runStrategyAdvisor = async () => {
    setStrategyBusy(true);
    setError(null);
    // Deliberately DO NOT pass providerId here. The server's advisor picks
    // an enabled API provider and skips CLI providers — the toolkit's CLI
    // runner shells out with shell:true and chokes on parens/quotes in the
    // long strategy prompt. If the UI's "default" happens to be a CLI
    // provider (e.g. gemini), passing it would override the API preference
    // and cause a shell syntax error at run time.
    const r = await req('POST', '/api/ai/advise-strategy', {})
      .catch((e) => ({ ok: false, error: e.message }));
    setStrategyBusy(false);
    if (!r.ok) { setError(r.error || 'advisor failed'); return; }
    setSelectedRun(r.runId);
    setRunOutput('');
    await refresh();
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col h-full gap-2 overflow-auto">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-sky-400" />
          <div className="text-xs uppercase tracking-wider text-slate-300 font-semibold">AI Providers</div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={runStrategyAdvisor}
            disabled={strategyBusy || !providers.some((p) => p.enabled && p.type === 'api')}
            title={providers.some((p) => p.enabled && p.type === 'api')
              ? 'Ask the LLM to evaluate the fleet against strategy.md'
              : 'Add and enable an API provider (CLI providers don\'t work for the advisor)'}
            className="px-2 py-1 rounded border border-sky-900 hover:border-sky-500 text-sky-300 text-xs flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
            <BookOpen className="w-3 h-3" /> {strategyBusy ? 'Running…' : 'Consult strategy'}
          </button>
          <button onClick={startAdd}
            className="px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs flex items-center gap-1">
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      </div>

      {error ? (
        <div className="text-[11px] text-rose-300 bg-rose-950/30 border border-rose-900 rounded px-2 py-1">{error}</div>
      ) : null}

      {editing ? (
        <div className="border border-sky-900/60 rounded p-2 bg-slate-950 space-y-1 text-[11px]">
          <div className="grid grid-cols-2 gap-1">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Name" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5">
              <option value="api">API</option>
              <option value="cli">CLI</option>
            </select>
            {form.type === 'api' ? (
              <>
                <input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                  placeholder="https://api.example.com/v1" className="col-span-2 bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
                <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder="API key (optional)" className="col-span-2 bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
              </>
            ) : (
              <>
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="claude" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
                <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder="--print -p" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
              </>
            )}
            <input value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })}
              placeholder="model-a, model-b" className="col-span-2 bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
            <input value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
              placeholder="default model" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
            <input value={form.lightModel} onChange={(e) => setForm({ ...form, lightModel: e.target.value })}
              placeholder="light model (advisor)" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
            <input type="number" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: e.target.value })}
              placeholder="timeout ms" className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5" />
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> enabled
            </label>
          </div>
          <div className="flex gap-1 justify-end pt-1">
            <button onClick={cancel} className="px-2 py-0.5 text-slate-400 hover:text-slate-200">Cancel</button>
            <button onClick={save} className="px-2 py-0.5 bg-sky-600 hover:bg-sky-500 text-white rounded">
              {editing === 'new' ? 'Create' : 'Save'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="space-y-1">
        {providers.length === 0 ? (
          <div className="text-[11px] text-slate-500 text-center py-4">
            No providers configured. Add one to enable the advisor and strategic consultations.
          </div>
        ) : providers.map((p) => {
          const t = tests[p.id];
          const isActive = p.id === activeId;
          return (
            <div key={p.id} className={`border rounded p-2 text-[11px] ${isActive ? 'border-sky-700 bg-sky-950/20' : 'border-slate-800 bg-slate-950'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-200">{p.name}</span>
                <span className={`px-1 rounded uppercase text-[9px] ${p.type === 'cli' ? 'bg-blue-900 text-blue-200' : 'bg-violet-900 text-violet-200'}`}>{p.type}</span>
                {!p.enabled ? <span className="px-1 rounded bg-slate-800 text-slate-400 text-[9px]">disabled</span> : null}
                {isActive ? <span className="px-1 rounded bg-sky-800 text-sky-100 text-[9px]">default</span> : null}
                {t && !t.testing ? (
                  t.success
                    ? <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t.version || 'ok'}</span>
                    : <span className="text-rose-400 flex items-center gap-1"><XCircle className="w-3 h-3" />{t.error?.slice(0, 40)}</span>
                ) : null}
              </div>
              <div className="text-slate-400 mt-0.5 break-all">
                {p.type === 'api' ? p.endpoint : `${p.command || ''} ${(p.args || []).join(' ')}`}
              </div>
              {p.models?.length ? (
                <div className="text-slate-500">Models: {p.models.slice(0, 6).join(', ')}{p.models.length > 6 ? ` +${p.models.length - 6}` : ''}</div>
              ) : null}
              {(p.defaultModel || p.lightModel) ? (
                <div className="text-slate-500">
                  {p.defaultModel ? <>default: <span className="text-slate-300">{p.defaultModel}</span></> : null}
                  {p.lightModel ? <> · light: <span className="text-emerald-300">{p.lightModel}</span></> : null}
                </div>
              ) : null}
              <div className="flex gap-1 flex-wrap mt-1">
                <button onClick={() => test(p.id)} disabled={t?.testing}
                  className="px-1.5 py-0.5 rounded border border-slate-700 hover:border-slate-500 text-slate-300 flex items-center gap-1">
                  <Play className="w-3 h-3" /> {t?.testing ? 'Testing…' : 'Test'}
                </button>
                {p.type === 'api' ? (
                  <button onClick={() => refreshModels(p.id)}
                    className="px-1.5 py-0.5 rounded border border-slate-700 hover:border-slate-500 text-slate-300 flex items-center gap-1">
                    <RefreshCcw className="w-3 h-3" /> Refresh models
                  </button>
                ) : null}
                <button onClick={() => toggleEnabled(p)}
                  className="px-1.5 py-0.5 rounded border border-slate-700 hover:border-slate-500 text-slate-300">
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
                {!isActive && p.enabled ? (
                  <button onClick={() => setActive(p.id)}
                    className="px-1.5 py-0.5 rounded border border-sky-800 hover:border-sky-500 text-sky-300">
                    Set default
                  </button>
                ) : null}
                <button onClick={() => startEdit(p)}
                  className="px-1.5 py-0.5 rounded border border-slate-700 hover:border-slate-500 text-slate-300 flex items-center gap-1">
                  <Edit2 className="w-3 h-3" /> Edit
                </button>
                <button onClick={() => del(p.id)}
                  className="px-1.5 py-0.5 rounded border border-rose-900 hover:border-rose-500 text-rose-300 flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-800 pt-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Recent runs</div>
        {runs.length === 0 ? (
          <div className="text-[11px] text-slate-500">No runs yet.</div>
        ) : (
          <div className="space-y-0.5">
            {runs.slice(0, 8).map((r) => (
              <button key={r.id} onClick={() => { setSelectedRun(r.id); setRunOutput(''); }}
                className={`w-full text-left text-[11px] px-2 py-1 rounded border ${selectedRun === r.id ? 'border-sky-700 bg-sky-950/20' : 'border-slate-800 hover:border-slate-600'} flex items-center gap-2`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${r.success === true ? 'bg-emerald-500' : r.success === false ? 'bg-rose-500' : 'bg-amber-400 animate-pulse'}`} />
                <span className="text-slate-300 truncate flex-1">{r.source || 'run'}: {(r.prompt || '').slice(0, 60)}</span>
                <span className="text-slate-500 shrink-0">{r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '…'}</span>
              </button>
            ))}
          </div>
        )}
        {selectedRun ? (
          <pre className="mt-2 max-h-56 overflow-auto text-[11px] bg-slate-950 border border-slate-800 rounded p-2 text-slate-300 whitespace-pre-wrap">
            {runOutput || 'Waiting for output…'}
          </pre>
        ) : null}
      </div>
    </div>
  );
};
