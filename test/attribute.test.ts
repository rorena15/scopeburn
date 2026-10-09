import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attribute, UNATTRIBUTED } from '../src/attribute.ts';
import type { UsageRecord } from '../src/logs.ts';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, fast: false, geoUS: false };
let n = 0;
const rec = (o: Partial<UsageRecord>): UsageRecord => ({
  key: `k${n++}`, ts: 0, model: 'm', session: 's1', agent: null, turn: 's1#1', repos: {}, cwdRepo: null, version: null, entrypoint: 'cli', usage, ...o,
});

test('own paths split proportionally', () => {
  const [a] = attribute([rec({ repos: { A: 3, B: 1 } })]);
  assert.equal(a.level, 'direct');
  assert.deepEqual(a.shares, [{ repo: 'A', weight: 0.75 }, { repo: 'B', weight: 0.25 }]);
});

test('responses without paths inherit the turn majority before the session majority', () => {
  const rs = [
    rec({ turn: 't1', repos: { A: 1 } }),
    rec({ turn: 't2', repos: { B: 5 } }),
    rec({ turn: 't1' }),
  ];
  const out = attribute(rs);
  assert.equal(out[2].level, 'turn');
  assert.equal(out[2].shares[0].repo, 'A');
});

test('falls back to session, then cwd, then unattributed', () => {
  const s = attribute([rec({ session: 'x', turn: 'x#1', repos: { A: 1 } }), rec({ session: 'x', turn: 'x#2' })]);
  assert.equal(s[1].level, 'session');
  const c = attribute([rec({ session: 'y', turn: 'y#1', cwdRepo: 'C' })]);
  assert.deepEqual([c[0].level, c[0].shares[0].repo], ['cwd', 'C']);
  const none = attribute([rec({ session: 'z', turn: 'z#1' })]);
  assert.deepEqual([none[0].level, none[0].shares[0].repo], ['none', UNATTRIBUTED]);
});
