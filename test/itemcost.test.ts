import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Attributed } from '../src/attribute.ts';
import { timelines, type Snapshot } from '../src/history.ts';
import { itemCosts, project } from '../src/itemcost.ts';
import type { UsageRecord } from '../src/logs.ts';
import { loadPrices } from '../src/prices.ts';
import { parseRoadmap } from '../src/roadmap.ts';

const prices = loadPrices();
const REPO = path.join(os.tmpdir(), 'not-a-repo-scopeburn');
let n = 0;
// $1 each: 50,000 output tokens on sonnet-5 ($10/MTok... 0.1M × 10 = $1 → 100,000 tokens)
const use = (iso: string, repo = REPO): Attributed => ({
  rec: {
    key: `k${n++}`, ts: Date.parse(iso), model: 'claude-sonnet-5', session: 's', agent: null, turn: 't', repos: {}, cwdRepo: null, version: null, entrypoint: 'cli',
    usage: { input: 0, output: 100_000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, fast: false, geoUS: false },
  } as UsageRecord,
  shares: [{ repo, weight: 1 }],
  level: 'direct',
});
const tlOf = (md: string) => timelines([{ ts: Date.parse('2026-10-10T12:00:00'), source: 'git', commit: null, roadmap: parseRoadmap(md) } as Snapshot], '2026-10-10');

test('usage goes to items in progress at that time, split by points', () => {
  const tl = tlOf(
    '- [x] {A} a ~S @decided(2026-10-01) @done(2026-10-02)\n' +
      '- [ ] {B} b ~L @start(2026-10-02)\n' +
      '- [-] {C} c @decided(2026-10-01) @cut(2026-10-03)\n' +
      '- [ ] {D} d @start(2026-10-01) @paused(2026-10-01)',
  );
  const c = itemCosts(REPO, [use('2026-10-01T10:00:00'), use('2026-10-02T10:00:00'), use('2026-10-05T10:00:00'), use('2026-10-05T11:00:00', 'elsewhere')], tl, prices);
  const usd = (k: string) => Math.round((c.byItem.get(k)?.usd ?? 0) * 100) / 100;
  // 10-01: A and paused-same-day D share it (1:2); 10-02: A(1) and B(4); 10-05: B only. C was cut without @start: nothing.
  assert.equal(usd('A'), Math.round((1 / 3 + 1 / 5) * 100) / 100);
  assert.equal(usd('B'), Math.round((4 / 5 + 1) * 100) / 100);
  assert.equal(usd('C'), 0);
  assert.equal(Math.round(c.total.usd), 3); // the 'elsewhere' record isn't this repo's
  assert.equal(c.outside.usd, 0);
});

test('a commit tagged with {ID} claims usage since the previous commit', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'scopeburn-git-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q');
  const commit = (msg: string, iso: string) => {
    writeFileSync(path.join(repo, 'f.txt'), msg);
    g('add', '.');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', msg], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso } });
  };
  commit('start', '2026-10-01T09:00:00');
  commit('work on {B}', '2026-10-01T12:00:00');
  const tl = tlOf('- [ ] {A} a @start(2026-10-01)\n- [ ] {B} b @start(2026-10-01)');
  const c = itemCosts(repo, [use('2026-10-01T10:00:00', repo), use('2026-10-01T13:00:00', repo)], tl, prices);
  assert.equal(c.taggedCommits, 1);
  // 10:00 falls in the tagged window → all to B; 13:00 is after it → split between A and B.
  assert.equal(Math.round(c.byItem.get('B')!.usd * 100) / 100, 1.5);
  assert.equal(Math.round(c.byItem.get('A')!.usd * 100) / 100, 0.5);
});

test('projection uses the median cost per point of finished items, else the fallback', () => {
  const md = Array.from({ length: 5 }, (_, i) => `- [x] {D${i}} d ~S @decided(2026-10-0${i + 1}) @done(2026-10-0${i + 1})`).join('\n') + '\n- [ ] {O} open ~L';
  const tl = tlOf(md);
  const c = itemCosts(REPO, [1, 2, 3, 4, 5].map((d) => use(`2026-10-0${d}T10:00:00`)), tl, prices);
  const p = project(tl, c, null)!;
  assert.deepEqual([p.basis, p.remainingPoints, Math.round(p.usd)], ['project', 4, 4]);
  const few = tlOf('- [x] {A} a @decided(2026-10-01) @done(2026-10-01)\n- [ ] {B} b');
  assert.equal(project(few, itemCosts(REPO, [use('2026-10-01T10:00:00')], few, prices), null), null);
  assert.equal(project(few, itemCosts(REPO, [], few, prices), 3)!.basis, 'all-projects');
});
