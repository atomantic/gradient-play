import React, { useState } from 'react';
import { api } from '../api.js';
import { Send } from 'lucide-react';

export const DirectChat = () => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    const r = await api.sendPrompt(text).catch((e) => ({ ok: false, error: e.message }));
    setResult(r);
    if (r.ok) setText('');
    setSending(false);
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Direct prompt</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Type a one-off command for the in-game AI…"
        className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-sm font-mono resize-none focus:outline-none focus:border-cyan-600"
      />
      <div className="flex items-center justify-between mt-2">
        <div className="text-[11px] text-slate-500">
          {result?.ok ? `sent · ${result.via}` : result?.error ? `err: ${result.error}` : ''}
        </div>
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          className="px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 text-white text-sm flex items-center gap-1"
        >
          <Send className="w-3 h-3" />
          {sending ? 'sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
};
