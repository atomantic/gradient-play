import { chromium } from 'playwright-core';
import { getCredentials } from './credentials.js';

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:5556';
const GAME_URL = process.env.GAME_URL || 'https://game.gradient-bang.com';

const state = {
  browser: null,
  page: null,
  lastError: null,
  connectedAt: null
};

const matchesGameHost = (url = '') => {
  try {
    const u = new URL(url);
    return u.host.includes('gradient-bang.com');
  } catch { return false; }
};

const findGamePage = (contexts) => {
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (matchesGameHost(page.url())) return page;
    }
  }
  return null;
};

const ensureBrowser = async () => {
  if (state.browser && state.browser.isConnected()) return state.browser;
  state.browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  state.browser.on('disconnected', () => {
    state.browser = null;
    state.page = null;
  });
  return state.browser;
};

export const connectGamePage = async () => {
  try {
    const browser = await ensureBrowser();
    const contexts = browser.contexts();
    let page = findGamePage(contexts);
    if (!page) {
      const ctx = contexts[0] ?? await browser.newContext();
      page = await ctx.newPage();
      await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
    } else {
      try { await page.bringToFront(); } catch { /* ignore */ }
    }
    state.page = page;
    state.connectedAt = Date.now();
    state.lastError = null;
    return { ok: true, url: page.url() };
  } catch (err) {
    state.lastError = err.message;
    return { ok: false, error: err.message };
  }
};

const withPage = async () => {
  if (state.page && !state.page.isClosed()) return state.page;
  const result = await connectGamePage();
  if (!result.ok) throw new Error(result.error || 'CDP not connected');
  return state.page;
};

export const getConnectionStatus = async () => {
  const connected = !!(state.page && !state.page.isClosed() && state.browser?.isConnected());
  return {
    connected,
    cdpEndpoint: CDP_ENDPOINT,
    gameUrl: GAME_URL,
    pageUrl: connected ? state.page.url() : null,
    connectedAt: state.connectedAt,
    lastError: state.lastError
  };
};

/**
 * Read game state from the DOM.
 *
 * Zustand stores are not exposed on window, so we scrape the PlayerShipPanel
 * and TopBarCreditBalance. Values read via icon-adjacent numeric text.
 */
export const getGameSnapshot = async () => {
  const page = state.page;
  if (!page || page.isClosed()) {
    return { ok: false, connected: false };
  }
  const snap = await page.evaluate(() => {
    const toNum = (s) => {
      if (!s) return null;
      const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    };

    const extracted = {};

    // Top bar renders two [data-tutorial="credits"] elements labelled "BANK" and "ON HAND".
    for (const n of document.querySelectorAll('[data-tutorial="credits"]')) {
      const txt = (n.innerText || '').toUpperCase();
      const val = toNum(txt);
      if (val == null) continue;
      if (txt.includes('BANK')) extracted.creditsBank = val;
      else if (txt.includes('HAND')) extracted.creditsOnHand = val;
    }
    if (extracted.creditsOnHand != null) extracted.credits = extracted.creditsOnHand;

    const ships = [];

    // Player's own ship lives in an <aside> header with FUEL/FGHT/SHLD cur/max labels.
    // Name is rendered in ".uppercase.text-white.font-semibold" WITHOUT "text-sm".
    const playerNameEl = document.querySelector('.uppercase.text-white.font-semibold:not(.text-sm)');
    if (playerNameEl) {
      const aside = playerNameEl.closest('aside') || playerNameEl.closest('header') || playerNameEl.parentElement;
      const asideText = aside?.innerText || '';
      const parseRatio = (label) => {
        const m = asideText.match(new RegExp(label + '\\s+(\\d+)\\s*/\\s*(\\d+)', 'i'));
        return m ? { cur: Number(m[1]), max: Number(m[2]) } : null;
      };
      const fuel = parseRatio('FUEL');
      const fght = parseRatio('FGHT');
      const shld = parseRatio('SHLD');
      const cargo = parseRatio('CARGO');
      // Movement history lives in the same aside; most recent row's TO column is current sector.
      // Rows look like: "Apr 15, 15:26\t3918\t780\t...\t1 MINUTE AGO"
      let currentSector = null;
      const moveMatch = asideText.match(/[A-Z][a-z]{2}\s+\d+,\s+\d{2}:\d{2}\s+(\d+)\s+(\d+)/);
      if (moveMatch) currentSector = Number(moveMatch[2]);

      ships.push({
        name: playerNameEl.innerText?.trim(),
        primary: true,
        warpPower: fuel?.cur ?? null,
        warpMax: fuel?.max ?? null,
        fighters: fght?.cur ?? null,
        fightersMax: fght?.max ?? null,
        shields: shld?.cur ?? null,
        shieldsMax: shld?.max ?? null,
        cargo: cargo?.cur ?? null,
        cargoMax: cargo?.max ?? null,
        sector: currentSector,
        credits: null,
        active: null
      });
    }

    // Corp fleet: each ShipCard is a <div> with a <dl> child containing exactly 3
    // <dd class="tabular-nums"> (warp, fighters, shields) plus three .inline-flex badges
    // (sector, ship-credits, active/inactive).
    const shipCards = Array.from(document.querySelectorAll('div')).filter((d) => {
      const dl = d.querySelector(':scope > dl');
      if (!dl) return false;
      return dl.querySelectorAll('dd.tabular-nums').length === 3
        && !!d.querySelector('.text-sm.uppercase.text-white.font-semibold');
    });
    for (const card of shipCards) {
      const name = card.querySelector('.text-sm.uppercase.text-white.font-semibold')?.innerText?.trim();
      const dds = card.querySelectorAll('dl dd.tabular-nums');
      const badges = card.querySelectorAll('.inline-flex');
      const stateTxt = Array.from(badges).map((b) => b.innerText).join(' ').toUpperCase();
      ships.push({
        name,
        primary: false,
        warpPower: toNum(dds[0]?.innerText),
        fighters: toNum(dds[1]?.innerText),
        shields: toNum(dds[2]?.innerText),
        sector: badges[0] ? toNum(badges[0].innerText) : null,
        credits: badges[1] ? toNum(badges[1].innerText) : null,
        active: stateTxt.includes('ACTIVE') && !stateTxt.includes('INACTIVE')
      });
    }

    extracted.ships = ships;
    const primary = ships.find((s) => s.primary) || ships[0];
    if (primary) {
      extracted.shipName = primary.name;
      extracted.sector = primary.sector;
      extracted.warpPower = primary.warpPower;
      extracted.warpMax = primary.warpMax;
      extracted.fighters = primary.fighters;
      extracted.fightersMax = primary.fightersMax;
      extracted.shields = primary.shields;
      extracted.shieldsMax = primary.shieldsMax;
      extracted.cargo = primary.cargo;
      extracted.cargoMax = primary.cargoMax;
      extracted.shipCredits = primary.credits;
    }

    // Char/corp name lives at the top-left of the HUD.
    const corpHeader = document.querySelector('header')?.innerText?.split('\n')[0]?.trim();
    if (corpHeader && corpHeader.length < 100) extracted.corpHeader = corpHeader;

    // Task cards — each autonomous task renders a card containing "ENGINE STATUS: <state>".
    // The card itself is a sibling of the engine-status text; walking up finds the <div class="group relative flex-1 min-w-0 ...">.
    const taskTextNodes = Array.from(document.querySelectorAll('*')).filter((e) => {
      const own = Array.from(e.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ');
      return /ENGINE\s*STATUS/i.test(own);
    });
    const seenCards = new Set();
    const tasks = [];
    for (const node of taskTextNodes) {
      let card = node;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        const t = card.innerText || '';
        if (/ENGINE\s*STATUS/i.test(t) && t.length > 30 && t.length < 600) break;
      }
      if (seenCards.has(card)) continue;
      seenCards.add(card);
      const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
      const statusMatch = text.match(/ENGINE\s*STATUS:\s*([A-Z]+)/i);
      const status = statusMatch ? statusMatch[1].toUpperCase() : null;
      const description = text.replace(/\s*ENGINE\s*STATUS:.*$/i, '').trim();
      tasks.push({ description, status, working: status === 'WORKING' });
    }
    extracted.tasks = tasks;
    extracted.anyTaskWorking = tasks.some((t) => t.working);

    const slotsMatch = (document.body?.innerText || '').match(/(\d+)\s*\/\s*(\d+)\s*SLOTS?\s*USED/i);
    if (slotsMatch) extracted.taskSlots = { used: Number(slotsMatch[1]), total: Number(slotsMatch[2]) };

    const chatScroll = document.querySelector('[data-slot="scroll-area-viewport"], .scroll-area-viewport, [data-radix-scroll-area-viewport]');
    const lastMessages = [];
    if (chatScroll) {
      const children = chatScroll.querySelectorAll(':scope > div, :scope > * > div');
      const arr = Array.from(children).slice(-5);
      for (const c of arr) lastMessages.push(c.innerText?.slice(0, 400));
    }
    extracted.lastMessages = lastMessages;

    return { extracted };
  });
  return { ok: true, connected: true, url: page.url(), ...snap };
};

const SEND_THROTTLE_MS = 2100;
let lastSendAt = 0;

const findAssistantInput = async (page) => {
  const candidates = [
    'input[data-slot="input"][placeholder="Enter command"]',
    'input[placeholder="Enter command"]',
    'input[data-slot="input"]',
    'textarea[placeholder*="command" i]',
    '[contenteditable="true"][role="textbox"]'
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      if (await loc.isVisible().catch(() => false)) return { loc, sel };
    }
  }
  return null;
};

export const sendAssistantPrompt = async (text) => {
  const page = await withPage();
  const now = Date.now();
  const wait = lastSendAt + SEND_THROTTLE_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const input = await findAssistantInput(page);
  if (!input) return { ok: false, error: 'chat input not found' };
  await input.loc.click();
  await input.loc.fill('');
  await input.loc.type(text, { delay: 6 });
  await input.loc.press('Enter');
  lastSendAt = Date.now();
  return { ok: true, via: 'enter', inputSelector: input.sel };
};

/**
 * Click the character tile matching `name` on the character_select screen.
 * Tiles are [role="button"] containing an uppercase span with the character name.
 * Returns { ok, error } — ok:true if selection succeeded or no dialog was showing.
 */
export const selectCharacterIfNeeded = async (name) => {
  if (!name) return { ok: true, via: 'no-character-configured' };
  const page = await withPage();

  const dialogVisible = await page.locator('[role="dialog"]:has-text("Select Character"), :text("Select Character")').first().isVisible().catch(() => false);
  if (!dialogVisible) {
    // Maybe the tiles are visible without the dialog matcher — fall through to locator query
  }

  const target = name.trim();
  const re = new RegExp(`^\\s*${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

  const tile = page.locator('[role="button"]').filter({ hasText: re }).first();
  const count = await tile.count();
  if (!count) return { ok: true, via: 'no-tile-shown' };
  if (!(await tile.isVisible().catch(() => false))) return { ok: true, via: 'tile-hidden' };

  await tile.click();
  // After click, the dialog dismisses. Wait briefly for transition.
  await page.waitForTimeout(500);
  return { ok: true, via: `clicked:${target}` };
};

/**
 * Detect login screen, fill credentials from keychain/file, submit, then pick
 * the configured character tile if the character_select dialog appears.
 */
export const loginIfNeeded = async () => {
  const page = await withPage();
  const emailInput = page.locator('input[data-slot="input"][type="email"], input[type="email"]').first();
  const hasEmailField = await emailInput.count() && await emailInput.isVisible().catch(() => false);

  const creds = getCredentials();
  let loginVia = 'already-authed';

  if (hasEmailField) {
    if (!creds) return { ok: false, error: 'no credentials stored — set them first' };
    const email = page.locator('input[data-slot="input"][type="email"], input[type="email"]').first();
    const password = page.locator('input[data-slot="input"][type="password"], input[type="password"]').first();
    if (!(await email.count()) || !(await password.count())) {
      return { ok: false, error: 'login form not found' };
    }
    await email.click();
    await email.fill(creds.email);
    await password.click();
    await password.fill(creds.password);
    const submit = page.locator('button:has-text("Join"), [data-slot="button"]:has-text("Join"), button[type="submit"]').first();
    if (await submit.count()) await submit.click();
    else await password.press('Enter');
    await page.waitForSelector('input[type="email"]', { state: 'hidden', timeout: 8000 }).catch(() => {});
    loginVia = 'submitted';
  } else {
    const signInBtn = page.locator('button:has-text("Sign In"), [data-slot="button"]:has-text("Sign In")').first();
    if (await signInBtn.count() && await signInBtn.isVisible().catch(() => false)) {
      await signInBtn.click();
      await page.waitForSelector('input[type="email"]', { timeout: 5000 }).catch(() => {});
      return loginIfNeeded(); // recurse once the form is visible
    }
  }

  // Whether or not we just submitted, check for the character-select step.
  const charName = creds?.character;
  if (charName) {
    // Wait briefly for the dialog to render after login.
    await page.waitForTimeout(600);
    const charResult = await selectCharacterIfNeeded(charName);
    return { ok: true, via: loginVia, character: charResult.via };
  }

  return { ok: true, via: loginVia };
};
