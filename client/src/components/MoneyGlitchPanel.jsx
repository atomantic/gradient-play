import React, { useEffect, useState } from 'react';
import { Zap, Target, Play, Trash2, AlertTriangle, CircleDot } from 'lucide-react';
import { api } from '../api.js';

const fmtTs = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour12: false }) : '—';

const hostOf = (url) => {
  try { return new URL(url).host; } catch { return url; }
};

export const MoneyGlitchPanel = () => {
  const [state, setState] = useState(null);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState('');
  const [parallel, setParallel] = useState(5);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = async () => {
    const s = await api.glitchState().catch((e) => ({ error: e.message }));
    setState(s);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, []);

  const arm = async () => {
    setErr(null);
    const r = await api.glitchArm().catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) setErr(r.error || 'arm failed');
    await refresh();
  };
  const disarm = async () => {
    await api.glitchDisarm().catch(() => {});
    await refresh();
  };
  const clearCapture = async () => {
    await api.glitchClearCapture().catch(() => {});
    setLastRun(null);
    await refresh();
  };

  const fire = async () => {
    setBusy(true);
    setErr(null);
    setLastRun(null);
    const body = { count: Number(parallel) || 1 };
    if (amount !== '') body.amount = Number(amount);
    if (direction) body.direction = direction;
    const r = await api.glitchFire(body).catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    if (!r.ok) {
      setErr(r.error || 'fire failed');
      return;
    }
    setLastRun(r);
    await refresh();
  };

  const cap = state?.capture;
  const capBody = cap?.body && typeof cap.body === 'object' ? cap.body : null;
  const inheritedDirection = capBody?.direction;
  const inheritedAmount = capBody?.amount;

  const rows = lastRun?.results || [];
  const okRows = rows.filter((r) => r.ok);
  const failRows = rows.filter((r) => !r.ok);

  // Heuristic outcome summary.
  const effectiveDirection = direction || inheritedDirection;
  const effectiveAmount = amount !== '' ? Number(amount) : (inheritedAmount ?? 0);
  const intendedSingle = Number(effectiveAmount) || 0;
  const intendedTotal = intendedSingle * (lastRun?.count || 0);
  const appliedIfExploitWorks = intendedSingle * (lastRun?.okCount || 0);

  const verdictMeta = {
    'serialized':          { label: 'Serialized — NOT exploitable', tone: 'emerald' },
    'exploitable-full':    { label: '🚨 EXPLOITABLE — full duplication', tone: 'rose' },
    'exploitable-partial': { label: '⚠ Partial race detected', tone: 'amber' },
    'unexpected':          { label: 'Unexpected delta', tone: 'amber' },
    'all-failed':          { label: 'All calls failed', tone: 'slate' },
    'unknown':             { label: 'Inconclusive (ledger unread)', tone: 'slate' }
  };
  const toneClass = {
    emerald: 'border-emerald-700 bg-emerald-950/30 text-emerald-300',
    rose:    'border-rose-700 bg-rose-950/40 text-rose-200',
    amber:   'border-amber-700 bg-amber-950/30 text-amber-200',
    slate:   'border-slate-700 bg-slate-900/40 text-slate-300'
  };

  return (
    <div className="rounded-lg border border-rose-900/60 bg-slate-900/40 p-3 space-y-3 h-full overflow-auto">
      <div className="flex items-center gap-2">
        <Zap className="w-4 h-4 text-rose-400" />
        <div className="text-xs uppercase tracking-wider text-rose-300">Money Glitch — race test</div>
        {state?.armed ? (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-300">
            <CircleDot className="w-3 h-3 animate-pulse" /> armed
          </span>
        ) : (
          <span className="ml-auto text-[10px] text-slate-500">idle</span>
        )}
      </div>

      <div className="text-[11px] text-slate-400 leading-snug">
        Arm, then trigger one real <code className="text-slate-300">bank_transfer</code> in-game
        (e.g. ask the AI assistant to deposit 1 credit). We capture the real URL + auth headers,
        then replay N parallel copies to probe the read-check-write race.
      </div>

      <div className="flex gap-2">
        {!state?.armed ? (
          <button onClick={arm}
            className="px-3 py-1.5 rounded text-xs bg-rose-700 hover:bg-rose-600 text-white flex items-center gap-1">
            <Target className="w-3.5 h-3.5" /> Arm capture
          </button>
        ) : (
          <button onClick={disarm}
            className="px-3 py-1.5 rounded text-xs bg-slate-700 hover:bg-slate-600 text-white">
            Disarm
          </button>
        )}
        {cap ? (
          <button onClick={clearCapture}
            className="px-3 py-1.5 rounded text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </button>
        ) : null}
      </div>

      {err ? (
        <div className="text-[11px] text-rose-300 flex items-start gap-1">
          <AlertTriangle className="w-3.5 h-3.5 mt-[1px] shrink-0" />
          <span>{err}</span>
        </div>
      ) : null}

      <div className="rounded border border-slate-800 bg-slate-950/40 p-2 space-y-1 text-[11px]">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Captured template</div>
        {!cap ? (
          <div className="text-slate-500">
            {state?.armed ? 'Waiting for a real bank_transfer to capture…' : 'Arm and trigger a real bank_transfer first.'}
          </div>
        ) : (
          <div className="space-y-0.5">
            <div><span className="text-slate-500">host</span> <span className="font-mono text-slate-300">{hostOf(cap.url)}</span></div>
            <div><span className="text-slate-500">captured</span> <span className="text-slate-300">{fmtTs(cap.capturedAt)}</span></div>
            <div><span className="text-slate-500">direction</span> <span className="text-slate-200">{capBody?.direction ?? '—'}</span></div>
            <div><span className="text-slate-500">amount</span> <span className="font-mono text-emerald-300">{capBody?.amount ?? '—'}</span></div>
            {capBody?.target_player_name ? (
              <div><span className="text-slate-500">target</span> <span className="text-slate-200">{capBody.target_player_name}</span></div>
            ) : null}
            {capBody?.character_id ? (
              <div><span className="text-slate-500">character_id</span> <span className="font-mono text-slate-400">{capBody.character_id}</span></div>
            ) : null}
            {capBody?.ship_id ? (
              <div><span className="text-slate-500">ship_id</span> <span className="font-mono text-slate-400">{capBody.ship_id}</span></div>
            ) : null}
            {capBody?.ship_name ? (
              <div><span className="text-slate-500">ship_name</span> <span className="text-slate-200">{capBody.ship_name}</span></div>
            ) : null}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className="text-[10px] uppercase tracking-wider text-slate-500 flex flex-col gap-1">
          Direction
          <select value={direction} onChange={(e) => setDirection(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100">
            <option value="">inherit ({inheritedDirection ?? '—'})</option>
            <option value="deposit">deposit</option>
            <option value="withdraw">withdraw</option>
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-slate-500 flex flex-col gap-1">
          Amount
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder={String(inheritedAmount ?? '')}
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono" />
        </label>
        <label className="text-[10px] uppercase tracking-wider text-slate-500 flex flex-col gap-1">
          Parallel N
          <input type="number" min="1" max="50" value={parallel}
            onChange={(e) => setParallel(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 font-mono" />
        </label>
      </div>

      <button onClick={fire}
        disabled={busy || !cap}
        className="w-full px-3 py-2 rounded text-sm flex items-center justify-center gap-2 bg-rose-700 hover:bg-rose-600 disabled:bg-slate-800 disabled:text-slate-500 text-white">
        <Play className="w-4 h-4" />
        {busy ? 'firing…' : cap ? `Fire ${parallel || 1}× parallel` : 'Capture required'}
      </button>

      {lastRun ? (
        <div className="rounded border border-slate-800 bg-slate-950/40 p-2 space-y-2">
          {lastRun.verdict ? (
            <div className={`rounded border px-2 py-1.5 text-xs font-semibold ${toneClass[verdictMeta[lastRun.verdict]?.tone] || toneClass.slate}`}>
              {verdictMeta[lastRun.verdict]?.label || lastRun.verdict}
              {lastRun.duplicated != null && lastRun.verdict?.startsWith('exploitable') ? (
                <span className="ml-2 font-mono opacity-80">
                  ×{lastRun.duplicated} of {lastRun.okCount}
                </span>
              ) : null}
            </div>
          ) : null}

          {lastRun.ledger ? (
            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
              <div className="rounded border border-slate-800 p-1.5 bg-slate-950/60">
                <div className="text-[10px] uppercase text-slate-500">Bank</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-slate-400">{lastRun.ledger.before.bank ?? '—'}</span>
                  <span className="text-slate-600">→</span>
                  <span className="text-emerald-300">{lastRun.ledger.afterSettled.bank ?? '—'}</span>
                  {lastRun.ledger.bankDelta != null ? (
                    <span className={`ml-auto ${lastRun.ledger.bankDelta > 0 ? 'text-emerald-400' : lastRun.ledger.bankDelta < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                      {lastRun.ledger.bankDelta > 0 ? '+' : ''}{lastRun.ledger.bankDelta}
                    </span>
                  ) : null}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  expected 1×: <span className="text-slate-400">{lastRun.ledger.expectedBankDelta ?? '—'}</span>
                  {' · '}naive N×: <span className="text-slate-400">{lastRun.ledger.naiveBankDelta ?? '—'}</span>
                </div>
              </div>
              <div className="rounded border border-slate-800 p-1.5 bg-slate-950/60">
                <div className="text-[10px] uppercase text-slate-500">On Hand</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-slate-400">{lastRun.ledger.before.hand ?? '—'}</span>
                  <span className="text-slate-600">→</span>
                  <span className="text-emerald-300">{lastRun.ledger.afterSettled.hand ?? '—'}</span>
                  {lastRun.ledger.handDelta != null ? (
                    <span className={`ml-auto ${lastRun.ledger.handDelta > 0 ? 'text-emerald-400' : lastRun.ledger.handDelta < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
                      {lastRun.ledger.handDelta > 0 ? '+' : ''}{lastRun.ledger.handDelta}
                    </span>
                  ) : null}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  expected 1×: <span className="text-slate-400">{lastRun.ledger.expectedHandDelta ?? '—'}</span>
                  {' · '}naive N×: <span className="text-slate-400">{lastRun.ledger.naiveHandDelta ?? '—'}</span>
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between text-[11px]">
            <div className="text-slate-400">
              ok <span className="text-emerald-300 font-mono">{lastRun.okCount}</span>
              {' · '}fail <span className="text-rose-300 font-mono">{lastRun.failCount}</span>
              {' · '}wall <span className="text-slate-200 font-mono">{lastRun.totalMs}ms</span>
            </div>
            <div className="text-[10px] text-slate-500">
              {effectiveDirection} <span className="text-slate-400 font-mono">{intendedSingle}</span> × {lastRun.count}
            </div>
          </div>
          <div className="text-[10px] text-slate-500">
            Naive sum if every call landed: <span className="font-mono text-slate-300">{intendedTotal}</span>
            {' · '}Sum of ok: <span className="font-mono text-emerald-300">{appliedIfExploitWorks}</span>
          </div>

          <div className="max-h-64 overflow-auto border border-slate-800 rounded">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 bg-slate-900 text-slate-400 text-[10px] uppercase">
                <tr>
                  <th className="px-2 py-1 text-left">i</th>
                  <th className="px-2 py-1 text-left">status</th>
                  <th className="px-2 py-1 text-left">ms</th>
                  <th className="px-2 py-1 text-left">body</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.i} className={r.ok ? 'text-slate-300' : 'text-rose-300'}>
                    <td className="px-2 py-1 align-top">{r.i}</td>
                    <td className="px-2 py-1 align-top">{r.status || 'ERR'}</td>
                    <td className="px-2 py-1 align-top">{r.durationMs}</td>
                    <td className="px-2 py-1 align-top whitespace-pre-wrap break-all">
                      {typeof r.body === 'string' ? r.body : r.body ? JSON.stringify(r.body) : r.error || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {okRows.length > 1 ? (
            <div className="text-[11px] text-amber-300">
              ⚠ {okRows.length} parallel 200s — if bank/hand credits changed by that multiple of {intendedSingle}, race is exploitable.
            </div>
          ) : okRows.length === 1 && failRows.length > 0 ? (
            <div className="text-[11px] text-emerald-300">
              Only 1 of {rows.length} succeeded — race appears gated (rate limit, row lock, or similar).
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
