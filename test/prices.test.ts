import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, loadPrices, normalizeModel } from '../src/prices.ts';
import type { Usage } from '../src/logs.ts';

const u = (o: Partial<Usage>): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, fast: false, geoUS: false, ...o,
});
const prices = loadPrices();
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('normalizes provider prefixes and date suffixes', () => {
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('anthropic.claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
});

test('prices each token category, including the TTL split of cache writes', () => {
  // opus 5.5: in 4, out 20, 5m 5, 1h 8, read 0.2 per MTok
  close(costOf(prices, 'claude-opus-5-5', u({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 2e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 })), 4 + 20 + 0.2 + 5 + 8);
});

test('cache writes without a TTL split are priced at the 1h rate', () => {
  close(costOf(prices, 'claude-sonnet-5', u({ cacheWrite: 1e6 })), 4);
});

test('haiku 5.5 switches to long-prompt rates above 100K prompt tokens', () => {
  close(costOf(prices, 'claude-haiku-5-5', u({ input: 50_000, output: 1e6 })), 0.005 + 0.5);
  close(costOf(prices, 'claude-haiku-5-5', u({ input: 50_000, cacheRead: 60_000, output: 1e6 })), 0.025 + 0.003 + 2.5);
});

test('fast mode, US geo and web search are applied', () => {
  close(costOf(prices, 'claude-opus-5-5', u({ output: 1e6, fast: true })), 40);
  close(costOf(prices, 'claude-opus-5-5', u({ output: 1e6, geoUS: true })), 22);
  close(costOf(prices, 'claude-opus-5-5', u({ webSearch: 3 })), 0.03);
});

test('unknown models have no price instead of a zero price', () => {
  assert.equal(costOf(prices, 'claude-unknown-9', u({ input: 1 })), null);
});
