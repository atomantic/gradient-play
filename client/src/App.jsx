import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { ConnectionBar } from './components/ConnectionBar.jsx';
import { HUD } from './components/HUD.jsx';
import { MissionComposer } from './components/MissionComposer.jsx';
import { MissionList } from './components/MissionList.jsx';
import { MissionDetail } from './components/MissionDetail.jsx';
import { DirectChat } from './components/DirectChat.jsx';
import { CredentialsPanel } from './components/CredentialsPanel.jsx';
import { AutopilotPanel } from './components/AutopilotPanel.jsx';

export default function App() {
  const [status, setStatus] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [missions, setMissions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState(null);
  const [rightTab, setRightTab] = useState('mission'); // 'mission' | 'autopilot'

  const refresh = async () => {
    try {
      const [s, snap, ml, t] = await Promise.all([
        api.status(),
        api.snapshot().catch(() => ({ ok: false })),
        api.missions(),
        api.templates()
      ]);
      setStatus(s);
      setSnapshot(snap);
      setMissions(ml.missions || []);
      setTemplates(t.templates || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const handleConnect = async () => {
    await api.connect();
    await refresh();
  };

  const handleCreate = async (spec) => {
    const m = await api.createMission(spec);
    setSelectedId(m.id);
    await refresh();
  };

  const handleAbort = async (id) => {
    await api.abortMission(id);
    await refresh();
  };

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="text-cyan-400">Gradient</span> Play
          </h1>
          <span className="text-xs text-slate-500">automation companion</span>
          <div className="flex-1" />
          <ConnectionBar status={status} onConnect={handleConnect} />
        </div>
      </header>

      {error ? (
        <div className="bg-rose-950 text-rose-200 px-6 py-2 text-sm border-b border-rose-900">
          {error}
        </div>
      ) : null}

      <main className="flex-1 grid grid-cols-12 gap-4 p-4 max-w-[1600px] w-full mx-auto">
        <aside className="col-span-12 lg:col-span-3 space-y-4">
          <HUD snapshot={snapshot} />
          <CredentialsPanel />
          <DirectChat />
        </aside>

        <section className="col-span-12 lg:col-span-4 space-y-4">
          <MissionComposer
            templates={templates}
            ships={snapshot?.extracted?.ships || []}
            onCreate={handleCreate}
            onSaveTemplate={async (name, spec) => { await api.saveTemplate(name, spec); await refresh(); }}
            onDeleteTemplate={async (name) => { await api.deleteTemplate(name); await refresh(); }}
          />
          <MissionList
            missions={missions}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAbort={handleAbort}
          />
        </section>

        <section className="col-span-12 lg:col-span-5 flex flex-col">
          <div className="flex items-center gap-1 mb-2 text-xs">
            <button onClick={() => setRightTab('mission')}
              className={`px-3 py-1 rounded-t border-b-2 ${rightTab === 'mission' ? 'border-cyan-500 text-cyan-300' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
              Mission detail
            </button>
            <button onClick={() => setRightTab('autopilot')}
              className={`px-3 py-1 rounded-t border-b-2 ${rightTab === 'autopilot' ? 'border-emerald-500 text-emerald-300' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
              Autopilot
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {rightTab === 'mission' ? (
              <MissionDetail missionId={selectedId} onAbort={handleAbort} />
            ) : (
              <AutopilotPanel />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
