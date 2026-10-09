import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costBetween, estimateCap, FIVE_H, HOUR, reconstructWindows, windowStatus, type CostIndex } from '../src/limits.ts';
import { sampleFromPayload, toEpochMs, type Sample } from '../src/statusline.ts';

// $1 per response at the given times
const index = (times: number[]): CostIndex => ({ ts: times, cum: times.reduce((c, _, i) => [...c, i + 1], [0]) });
const T0 = Date.UTC(2026, 9, 10, 0, 0);

test('costBetween is half-open [from, to)', () => {
  const ix = index([T0, T0 + 10, T0 + 20]);
  assert.equal(costBetween(ix, T0, T0 + 20), 2);
  assert.equal(costBetween(ix, T0 + 1, T0 + 21), 2);
});

test('windows open at the first response after the previous one closed, floored to the hour', () => {
  const ix = index([T0 + 30 * 60_000, T0 + 4 * HOUR, T0 + 6 * HOUR]);
  assert.deepEqual(
    reconstructWindows(ix).map((w) => [(w.start - T0) / HOUR, (w.end - T0) / HOUR]),
    [[0, 5], [6, 11]],
  );
});

test('cap estimate pairs reported % with local spend since the window opened', () => {
  const reset = T0 + FIVE_H;
  const ix = index(Array.from({ length: 10 }, (_, i) => T0 + i * 60_000)); // $10 in the window
  const s: Sample = { ts: T0 + 20 * 60_000, session: null, five: { pct: 25, resetsAt: reset }, week: null, source: 'statusline' };
  const cap = estimateCap(ix, [s], 'five', 5)!;
  assert.equal(cap.median, 40);
  assert.equal(cap.samples, 1);
});

test('window status projects when the cap is hit', () => {
  const reset = T0 + FIVE_H;
  const now = T0 + HOUR;
  const times = Array.from({ length: 45 }, (_, i) => now - (i + 1) * 60_000); // $1/min over the last 45 min
  const ix = index(times.sort((a, b) => a - b));
  const s: Sample = { ts: now - 1, session: null, five: { pct: 50, resetsAt: reset }, week: null, source: 'statusline' };
  const w = windowStatus(ix, [s], 'five', now)!;
  assert.equal(w.exact, true);
  assert.equal(Math.round(w.burnPerHour), 60);
  assert.ok(w.hitsCapAt && w.hitsCapAt > now && w.hitsCapAt < reset);
});

test('status line payload parsing tolerates seconds, ms and ISO resets_at', () => {
  assert.equal(toEpochMs(1760000000), 1760000000000);
  assert.equal(toEpochMs(1760000000000), 1760000000000);
  assert.equal(toEpochMs('2026-10-10T05:00:00Z'), Date.UTC(2026, 9, 10, 5));
  const s = sampleFromPayload({ session_id: 'x', rate_limits: { five_hour: { used_percentage: 12, resets_at: 1760000000 } } }, 5)!;
  assert.deepEqual(s, { ts: 5, session: 'x', five: { pct: 12, resetsAt: 1760000000000 }, week: null, source: 'statusline' });
  assert.equal(sampleFromPayload({ model: { id: 'm' } }), null);
});
