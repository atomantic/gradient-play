import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Lock, LogIn, Trash2 } from 'lucide-react';

export const CredentialsPanel = () => {
  const [status, setStatus] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [character, setCharacter] = useState('');
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState(null);

  const refresh = async () => {
    const s = await fetch('/api/credentials').then((r) => r.json());
    setStatus(s);
    if (s.email) setEmail(s.email);
    if (s.character) setCharacter(s.character);
  };

  useEffect(() => { refresh(); }, []);

  const save = async () => {
    setMsg(null);
    const r = await api.saveTemplate ? null : null;
    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, character: character || null })
    }).then((r) => r.json());
    if (res.ok) {
      setMsg(`stored in ${res.backend}`);
      setPassword('');
      setEditing(false);
      await refresh();
    } else {
      setMsg(`err: ${res.error}`);
    }
  };

  const clear = async () => {
    await fetch('/api/credentials', { method: 'DELETE' });
    setPassword('');
    await refresh();
  };

  const login = async () => {
    setMsg('logging in…');
    const res = await fetch('/api/cdp/login', { method: 'POST' }).then((r) => r.json());
    setMsg(res.ok ? `logged in (${res.via})` : `err: ${res.error}`);
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-slate-400 flex items-center gap-1">
          <Lock className="w-3 h-3" /> Credentials
        </div>
        <span className="text-[10px] text-slate-500">{status?.backend}</span>
      </div>

      {status?.configured && !editing ? (
        <>
          <div className="text-sm text-slate-200 font-mono break-all">{status.email}</div>
          <div className="text-[11px] text-slate-500">
            character: <span className="text-cyan-300 font-mono">{status.character || '(none)'}</span>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={login}
              className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs flex items-center gap-1">
              <LogIn className="w-3 h-3" /> Auto-login
            </button>
            <button onClick={() => setEditing(true)}
              className="px-2 py-1 rounded border border-slate-700 hover:border-cyan-500 text-xs">
              Update
            </button>
            <button onClick={clear}
              className="px-2 py-1 rounded border border-rose-900 hover:border-rose-500 text-rose-300 text-xs flex items-center gap-1 ml-auto">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </>
      ) : (
        <>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
            className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-sm" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-sm font-mono" />
          <input type="text" value={character} onChange={(e) => setCharacter(e.target.value)}
            placeholder="character name (e.g. antic)"
            className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-sm" />
          <div className="flex items-center gap-2">
            <button onClick={save}
              className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs">
              Save
            </button>
            {editing ? (
              <button onClick={() => { setEditing(false); setPassword(''); refresh(); }}
                className="px-2 py-1 rounded border border-slate-700 text-xs">Cancel</button>
            ) : null}
          </div>
        </>
      )}
      {msg ? <div className="text-[11px] text-slate-400">{msg}</div> : null}
    </div>
  );
};
