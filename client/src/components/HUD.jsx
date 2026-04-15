import React from 'react';
import { Fuel, Coins, MapPin, Shield, Swords, Landmark, Package, Crown, Bot } from 'lucide-react';

const Stat = ({ icon: Icon, label, value, max, accent }) => (
  <div className="flex items-center gap-2 p-1.5 rounded bg-slate-900/60 border border-slate-800">
    <Icon className={`w-3.5 h-3.5 ${accent || 'text-slate-400'}`} />
    <div className="flex-1 min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-slate-500 leading-none">{label}</div>
      <div className="text-xs text-slate-100 font-mono truncate">
        {value ?? '—'}{max != null ? <span className="text-slate-500">/{max}</span> : null}
      </div>
    </div>
  </div>
);

const ShipRow = ({ ship }) => (
  <div className={`rounded border p-2 ${ship.primary ? 'border-cyan-700 bg-cyan-950/20' : 'border-slate-800 bg-slate-900/40'}`}>
    <div className="flex items-center justify-between gap-2 mb-1">
      <div className="flex items-center gap-1 min-w-0">
        {ship.primary ? <Crown className="w-3 h-3 text-cyan-400 shrink-0" /> : <Bot className="w-3 h-3 text-slate-500 shrink-0" />}
        <span className="text-[11px] font-semibold text-slate-100 truncate">{ship.name}</span>
      </div>
      {ship.active != null ? (
        <span className={`text-[9px] uppercase px-1 rounded ${ship.active ? 'bg-emerald-900/60 text-emerald-300' : 'text-slate-600'}`}>
          {ship.active ? 'active' : 'idle'}
        </span>
      ) : null}
    </div>
    <div className="grid grid-cols-3 gap-1">
      <Stat icon={Fuel} label="Warp" value={ship.warpPower} max={ship.warpMax} accent="text-amber-400" />
      <Stat icon={Swords} label="Fght" value={ship.fighters} max={ship.fightersMax} accent="text-rose-400" />
      <Stat icon={Shield} label="Shld" value={ship.shields} max={ship.shieldsMax} accent="text-sky-400" />
    </div>
    <div className="grid grid-cols-3 gap-1 mt-1">
      <Stat icon={MapPin} label="Sec" value={ship.sector} accent="text-cyan-400" />
      <Stat icon={Package} label="Crgo" value={ship.cargo} max={ship.cargoMax} accent="text-violet-400" />
      <Stat icon={Coins} label="Credits" value={ship.credits} accent="text-emerald-400" />
    </div>
  </div>
);

export const HUD = ({ snapshot }) => {
  const ex = snapshot?.extracted || {};
  const ships = ex.ships || [];
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-slate-400">Fleet</div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-slate-500">Bank</span>
          <span className="text-emerald-300 font-mono">{ex.creditsBank ?? '—'}</span>
          <span className="text-slate-500">·</span>
          <span className="text-slate-500">Hand</span>
          <span className="text-emerald-400 font-mono">{ex.creditsOnHand ?? '—'}</span>
        </div>
      </div>
      <div className="space-y-1.5">
        {ships.length === 0 ? (
          <div className="text-xs text-slate-500 py-4 text-center">No ships detected. Connect CDP.</div>
        ) : ships.map((s, i) => <ShipRow key={i} ship={s} />)}
      </div>
    </div>
  );
};
