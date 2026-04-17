#!/usr/bin/env node
/**
 * Connect to the live game via CDP and dump likely sources of map/sector
 * state (localStorage, IndexedDB, window globals, React fiber state).
 *
 * Run with:   node scripts/dump-map-state.js
 *
 * Needs the same CDP endpoint that the server uses. Defaults match server/cdp.js.
 */

import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(path.join(__dirname, '..', 'server', 'node_modules', 'playwright-core', 'index.mjs'));

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:5556';
const HOST_FILTER = 'gradient-bang.com';

const findGamePage = (browser) => {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      if (page.url().includes(HOST_FILTER)) return page;
    }
  }
  return null;
};

const dump = async (page) => page.evaluate(() => {
  const out = { localStorage: {}, fiberHits: [], topCollections: [], hints: [] };
  const KEY_RX = /sector|hex|tile|grid|visited|explored|known|frontier|cell|coord|x_pos|y_pos|q_pos/i;
  const all = []; // everything we find — used to rank by size at the end

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k) || '';
    out.localStorage[k] = { length: v.length, preview: v.slice(0, 200) };
  }

  const describe = (val, depth = 0) => {
    if (val == null) return null;
    if (val instanceof Map) return { kind: 'Map', size: val.size, sampleKeys: Array.from(val.keys()).slice(0, 5), sampleVal: [...val.values()].slice(0, 1) };
    if (val instanceof Set) return { kind: 'Set', size: val.size, sample: Array.from(val).slice(0, 5) };
    if (Array.isArray(val)) return { kind: 'Array', length: val.length, sample: val.slice(0, 3) };
    if (typeof val === 'object' && val.constructor === Object) {
      const keys = Object.keys(val);
      return { kind: 'Object', keys: keys.slice(0, 20), total: keys.length };
    }
    return { kind: typeof val, preview: String(val).slice(0, 80) };
  };

  const isInteresting = (val, keyName = '') => {
    if (val instanceof Map && val.size > 10) return true;
    if (val instanceof Set && val.size > 10) return true;
    if (Array.isArray(val) && val.length > 30) return true;
    if (keyName && KEY_RX.test(keyName)) return true;
    if (typeof val === 'object' && val && val.constructor === Object) {
      const keys = Object.keys(val);
      if (keys.some((k) => KEY_RX.test(k))) return true;
      const numKeys = keys.filter((k) => /^\d+$/.test(k));
      if (numKeys.length > 30) return true;
    }
    return false;
  };

  // Walk React fibers
  const root = document.getElementById('root') || document.querySelector('[data-reactroot]');
  const rootKey = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
  if (!root || !rootKey) { out.hints.push('no React root'); return out; }
  const container = root[rootKey];
  const hostRoot = container?.stateNode?.current || container?.current;
  const seen = new WeakSet();

  const scanValue = (val, label, ctx, depth = 0) => {
    if (!val || typeof val !== 'object') return;
    if (seen.has(val)) return;
    seen.add(val);
    if (depth > 4) return;
    // Track size-ranked
    let size = 0;
    if (val instanceof Map || val instanceof Set) size = val.size;
    else if (Array.isArray(val)) size = val.length;
    else if (val.constructor === Object) size = Object.keys(val).length;
    if (size > 15) all.push({ label: `${ctx.component}(d${ctx.depth}):${label}`, size, kind: val instanceof Map ? 'Map' : val instanceof Set ? 'Set' : Array.isArray(val) ? 'Array' : 'Object' });
    // Direct hit?
    if (isInteresting(val, label)) {
      out.fiberHits.push({ ...ctx, label, desc: describe(val) });
    }
    // Recurse into plain objects a few levels
    if (val.constructor === Object) {
      for (const k of Object.keys(val).slice(0, 80)) {
        scanValue(val[k], `${label}.${k}`, ctx, depth + 1);
      }
    } else if (Array.isArray(val) && val.length > 0 && val.length < 30) {
      // Small array — peek at items
      for (let i = 0; i < Math.min(3, val.length); i++) scanValue(val[i], `${label}[${i}]`, ctx, depth + 1);
    } else if (val instanceof Map && val.size > 0 && val.size < 20) {
      let i = 0;
      for (const [k, v] of val) { if (i++ > 3) break; scanValue(v, `${label}<${k}>`, ctx, depth + 1); }
    }
  };

  const walk = (fiber, depth = 0) => {
    if (!fiber || depth > 300) return;
    if (seen.has(fiber)) return; seen.add(fiber);
    const type = fiber.type;
    const name = (typeof type === 'function' && type.name) || (type && type.displayName) || (typeof type === 'string' ? type : '');
    const ctx = { component: name || '?', depth };
    // Hook chain
    let hook = fiber.memoizedState;
    let hookIdx = 0;
    while (hook && hookIdx < 80) {
      const m = hook.memoizedState;
      scanValue(m, `hook[${hookIdx}]`, ctx);
      const q = hook.queue?.lastRenderedState;
      scanValue(q, `hook[${hookIdx}].queue`, ctx);
      hook = hook.next; hookIdx++;
    }
    // Props — cheap win if a component receives a map array as prop
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      for (const k of Object.keys(props)) {
        if (isInteresting(props[k], k)) out.fiberHits.push({ ...ctx, label: `props.${k}`, desc: describe(props[k]) });
      }
    }
    walk(fiber.child, depth + 1);
    walk(fiber.sibling, depth + 1);
  };
  walk(hostRoot);

  // Rank discovered collections by size — the actual visited-sector set will
  // likely be one of the top few.
  all.sort((a, b) => b.size - a.size);
  out.topCollections = all.slice(0, 30);

  // For top 5 collections, drill down and dump sample items/keys so we can
  // identify which one is the universe sector list.
  const capture = (fiber, label, depth = 0) => {
    // We can't map back from label — instead re-walk and grab by matching
    // component name + hook index path. This simpler second pass collects
    // all candidate arrays/maps with size > 100 and prints first 3 items.
  };
  out.topSamples = [];
  const seen2 = new WeakSet();
  const walk2 = (fiber, depth = 0) => {
    if (!fiber || depth > 300) return;
    if (seen2.has(fiber)) return; seen2.add(fiber);
    const type = fiber.type;
    const name = (typeof type === 'function' && type.name) || (type && type.displayName) || (typeof type === 'string' ? type : '?');
    let hook = fiber.memoizedState;
    let hookIdx = 0;
    const localSeen = new WeakSet();
    const sample = (val, path, d = 0) => {
      if (!val || d > 6) return;
      if (typeof val === 'object') {
        if (localSeen.has(val)) return;
        localSeen.add(val);
      }
      if (Array.isArray(val) && val.length >= 100) {
        out.topSamples.push({ component: name, depth, path, size: val.length, kind: 'Array', sample: val.slice(0, 3) });
      } else if (val instanceof Map && val.size >= 100) {
        const s = [];
        let i = 0;
        for (const [k, v] of val) { if (i++ >= 3) break; s.push({ k, v }); }
        out.topSamples.push({ component: name, depth, path, size: val.size, kind: 'Map', sample: s });
      } else if (val instanceof Set && val.size >= 100) {
        out.topSamples.push({ component: name, depth, path, size: val.size, kind: 'Set', sample: Array.from(val).slice(0, 5) });
      } else if (val && typeof val === 'object' && val.constructor === Object) {
        for (const k of Object.keys(val).slice(0, 40)) sample(val[k], `${path}.${k}`, d + 1);
      }
    };
    while (hook && hookIdx < 80) {
      sample(hook.memoizedState, `hook[${hookIdx}]`);
      sample(hook.queue?.lastRenderedState, `hook[${hookIdx}].queue`);
      hook = hook.next; hookIdx++;
    }
    walk2(fiber.child, depth + 1);
    walk2(fiber.sibling, depth + 1);
  };
  walk2(hostRoot);
  return out;
});

const main = async () => {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const page = findGamePage(browser);
  if (!page) {
    console.error('no gradient-bang page found in CDP browser');
    process.exit(1);
  }
  const data = await dump(page);
  // IndexedDB is separate because it's async
  const idb = await page.evaluate(async () => {
    if (!indexedDB.databases) return { supported: false };
    try {
      const dbs = await indexedDB.databases();
      return { supported: true, dbs };
    } catch (e) {
      return { supported: true, error: e.message };
    }
  });
  data.indexedDB = idb;
  console.log(JSON.stringify(data, null, 2));
  await browser.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
