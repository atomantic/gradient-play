import { createAIToolkit } from 'portos-ai-toolkit/server';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAutopilotState } from './autopilot.js';
import { getGameSnapshot } from './cdp.js';

// DEFAULT_PROVIDERS_SAMPLE exported by the toolkit resolves to
// src/server/defaults/... but the file actually lives at src/defaults/...
// (toolkit packaging inconsistency). Compute the real path from our own
// location — the toolkit is installed as a sibling under node_modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidateSample = path.join(__dirname, 'node_modules/portos-ai-toolkit/src/defaults/providers.sample.json');
const sampleProvidersFile = existsSync(candidateSample) ? candidateSample : null;

export const aiToolkit = createAIToolkit({
  dataDir: path.join(process.cwd(), 'data/ai'),
  providersFile: 'providers.json',
  runsDir: 'runs',
  promptsDir: 'prompts',
  screenshotsDir: path.join(process.cwd(), 'data/ai/screenshots'),
  sampleProvidersFile
});

const shipLine = (s) =>
  `  ${s.name}: warp=${s.warpPower ?? '?'}  sector=${s.sector ?? '?'}  active=${s.active}  credits=${s.credits ?? '?'}  ${s.primary ? '[PRIMARY]' : ''}`.trim();

const recentLogLine = (e) => {
  const t = e.type;
  if (t === 'tick') return null;
  if (t === 'decision') return `dec:${e.key || '?'} ship=${e.ship || '?'} text=${String(e.text || '').slice(0, 120)}`;
  if (t === 'plan') return `plan:${e.goal} ${e.event} step=${e.step || e.fromStep || '?'} reason=${e.reason || ''}`.trim();
  if (t === 'event') return `event:${e.intelType || ''} ${String(e.snippet || '').slice(0, 80)}`;
  if (t === 'error') return `ERROR: ${String(e.error || '').slice(0, 120)}`;
  return `${t} ${JSON.stringify(e).slice(0, 120)}`;
};

/**
 * Build a diagnostic prompt from the current autopilot + game state. The LLM
 * is expected to return a prose action plan — the user (or a follow-up tool)
 * decides which steps to actually fire.
 */
export const buildAdvisorPrompt = (autopilotState, snapshot, extra = {}) => {
  const ex = snapshot?.extracted || {};
  const ships = ex.ships || [];
  const logTail = (autopilotState?.log || [])
    .map(recentLogLine)
    .filter(Boolean)
    .slice(-40)
    .join('\n');

  const shipsText = ships.map(shipLine).join('\n');
  const plans = (autopilotState?.plans || [])
    .map((p) => `  ${p.ship}: goal=${p.goal} step=${p.currentStep}/${p.steps.length}`)
    .join('\n');

  return `You are an advisor for a text-based MMO (Gradient Bang). The player runs an automated companion that drives an in-game AI assistant. The companion is stuck — please diagnose and recommend a recovery sequence.

GAME RULES (important):
- Ships have warpPower (fuel). Zero warp = stranded in space. Ships need warp to move.
- recharge_warp_power refuels a ship, but requires docking at a megaport AND credits.
- transfer_warp_power moves warp between two ships in the SAME sector (not necessarily a megaport).
- transfer_credits moves credits between two ships ONLY when both are docked at the SAME megaport.
- Megaports: 305, 472, 1413. Home hub: 1413.
- Only the primary ship has bank access (bank_withdraw / bank_deposit).
- Corp (non-primary) ships have their own credits but can only receive transfers when co-docked with primary.

CURRENT STATE
Bank: ${ex.creditsBank ?? '?'} credits   Primary on-hand: ${ex.creditsOnHand ?? '?'}
Ships:
${shipsText || '  (none in snapshot)'}

ACTIVE PLANS
${plans || '  (none)'}

RECENT AUTOPILOT EVENT LOG (newest last)
${logTail || '  (empty)'}

${extra.extraContext ? '\nADDITIONAL CONTEXT\n' + extra.extraContext + '\n' : ''}
${extra.question ? 'SPECIFIC QUESTION: ' + extra.question + '\n' : ''}
Please produce:
1. Diagnosis — what's stuck and why (1-3 sentences).
2. Step-by-step recovery plan — numbered actions, each expressed as a single directive the player could paste into the in-game assistant chat (e.g., "SAME HAULER: plot_course to sector 1629, then transfer_warp_power 150 to ANTIC KESTREL COURIER").
3. Code/config changes to the autopilot (if any) that would prevent this failure mode next time.
Keep it under 300 words total.`;
};

/**
 * Create an AI run that asks the configured advisor provider to diagnose the
 * autopilot's current state. Returns { runId, providerId, model } — the
 * caller polls /api/ai/runs/:id for output.
 */
export const adviseAutopilot = async ({ providerId, model, question, extraContext } = {}) => {
  const autopilot = getAutopilotState();
  const snapshot = await getGameSnapshot().catch(() => null);
  const prompt = buildAdvisorPrompt(autopilot, snapshot, { question, extraContext });

  // Pick a provider. Preference order:
  //   1. Caller-supplied providerId
  //   2. Any enabled API-type provider (LM Studio, Ollama, Kimi, etc.)
  //      — avoided CLI providers because the toolkit's CLI runner uses
  //      shell:true and fails to escape parens/quotes in the prompt.
  //   3. Configured activeProvider
  //   4. First enabled provider, any type
  const all = await aiToolkit.services.providers.getAllProviders();
  const list = all?.providers || []; // array
  const enabledApi = list.find((p) => p.enabled && p.type === 'api');
  const chosenId = providerId
    || enabledApi?.id
    || all?.activeProvider
    || list.find((p) => p.enabled)?.id
    || list[0]?.id;
  if (!chosenId) return { ok: false, error: 'no AI providers configured — add one via /api/ai/providers' };

  const provider = await aiToolkit.services.providers.getProviderById(chosenId);
  if (!provider) return { ok: false, error: `unknown provider: ${chosenId}` };
  const chosenModel = model || provider.lightModel || provider.defaultModel || provider.models?.[0];

  const runData = await aiToolkit.services.runner.createRun({
    providerId: chosenId,
    model: chosenModel,
    prompt,
    source: 'advisor'
  });

  const runId = runData.runId;
  const effectiveTimeout = runData.timeout;
  if (provider.type === 'cli') {
    aiToolkit.services.runner.executeCliRun(runId, provider, prompt, undefined, () => {}, () => {}, effectiveTimeout);
  } else if (provider.type === 'api') {
    aiToolkit.services.runner.executeApiRun(runId, provider, chosenModel, prompt, undefined, undefined, () => {}, () => {});
  }

  return { ok: true, runId, providerId: chosenId, model: chosenModel, promptPreview: prompt.slice(0, 200) };
};

// strategy.md lives at repo root. Cached in memory — re-read only when the
// file's mtime changes so we don't slam disk on every advisor tick.
const STRATEGY_DOC_PATH = path.resolve(__dirname, '..', 'strategy.md');
let strategyDocCache = { text: null, mtimeMs: 0 };
const loadStrategyDoc = () => {
  if (!existsSync(STRATEGY_DOC_PATH)) return '';
  const mtime = statSync(STRATEGY_DOC_PATH).mtimeMs ?? 0;
  if (strategyDocCache.text != null && mtime === strategyDocCache.mtimeMs) return strategyDocCache.text;
  const text = readFileSync(STRATEGY_DOC_PATH, 'utf8');
  strategyDocCache = { text, mtimeMs: mtime };
  return text;
};

/**
 * Run an advisor pass that includes the full strategy.md playbook as extra
 * context and asks the model to recommend the single most valuable next
 * move for the fleet. Used by the autopilot's strategic-advisor cadence and
 * by the /api/ai/advise-strategy "run now" button. Returns the same shape as
 * `adviseAutopilot` so the caller polls the run via /api/ai/runs/:id.
 */
export const adviseWithStrategy = async ({ providerId, model } = {}) => {
  const doc = loadStrategyDoc();
  const question = 'Using the strategy guide above, evaluate the fleet\'s current state and recommend the single highest-value next action (or short sequence). Be concrete: name ships, sectors, and tool calls. If the situation is stable and the rule-based autopilot is already doing the right thing, say so.';
  const extraContext = doc
    ? `STRATEGY GUIDE (strategy.md — treat as authoritative playbook for Gradient Bang):\n\n${doc}`
    : 'STRATEGY GUIDE: (strategy.md not found on disk — advise from first principles)';
  return adviseAutopilot({ providerId, model, question, extraContext });
};
