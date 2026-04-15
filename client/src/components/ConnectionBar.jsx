import React from 'react';

export const ConnectionBar = ({ status, onConnect }) => {
  const connected = status?.connected;
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
        <span className="text-slate-300">
          {connected ? 'CDP connected' : 'disconnected'}
        </span>
      </div>
      {status?.pageUrl ? (
        <span className="text-xs text-slate-500 truncate max-w-[260px]">{status.pageUrl}</span>
      ) : null}
      <button
        onClick={onConnect}
        className="px-3 py-1 rounded border border-slate-700 hover:border-cyan-500 hover:text-cyan-300 transition"
      >
        {connected ? 'Reconnect' : 'Connect'}
      </button>
    </div>
  );
};
