import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFloorLanguage } from './prompt-guard.js';

test('floor language: catches "keep Ncr" in trade prompts', () => {
  const r = detectFloorLanguage('Hauler A: trade profitably, keep 1000cr always on hand');
  assert.equal(r.matched, true);
});

test('floor language: catches "keep N credits"', () => {
  const r = detectFloorLanguage('hold 5000 credits on-hand while trading');
  assert.equal(r.matched, true);
});

test('floor language: catches "Ncr floor"', () => {
  const r = detectFloorLanguage('1000cr floor at all times');
  assert.equal(r.matched, true);
});

test('floor language: catches "on-hand minimum"', () => {
  const r = detectFloorLanguage('trade and respect on-hand minimum');
  assert.equal(r.matched, true);
});

test('floor language: catches "credit floor"', () => {
  const r = detectFloorLanguage('do not breach credit floor when buying');
  assert.equal(r.matched, true);
});

test('floor language: catches "maintain 500cr"', () => {
  const r = detectFloorLanguage('maintain 500cr at all times');
  assert.equal(r.matched, true);
});

test('floor language: allows legitimate trade prompts', () => {
  const prompts = [
    'Hauler A: fedspace trade run, your choice of ports.',
    'Execute NS round-trip buy 30 units and sell at 1413.',
    'plot_course to sector 305 and recharge_warp_power',
    'Refuel before warp power hits 50; do not run out mid-route',
    'never spend below MIN_RESERVE_WARP',
  ];
  for (const p of prompts) {
    const r = detectFloorLanguage(p);
    assert.equal(r.matched, false, `false positive on: ${p}`);
  }
});

test('floor language: allows deposit phrasing that does not name a credit floor', () => {
  assert.equal(detectFloorLanguage('bank_deposit 5000 and resume trading').matched, false);
});

test('floor language: flags deposit-like phrasing (bypass intended for these)', () => {
  const r = detectFloorLanguage('bank_deposit 3000 credits, keep 1000cr on hand, resume');
  assert.equal(r.matched, true);
});
