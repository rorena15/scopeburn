import assert from 'node:assert/strict';
import { test } from 'node:test';
import { burnup, summarize, timelines, type Snapshot } from '../src/history.ts';
import { parseRoadmap, totals } from '../src/roadmap.ts';

const MD = `# ROADMAP · demo
stage: beta

## Release 1
- [x] {A} Login ~S @done(2026-10-01)
- [ ] {B} Sync ~L @decided(2026-10-02) @start(2026-10-03)
  - [x] {B.1} Pull ~M
  - [ ] {B.2} Push
- [-] {C} Themes ~L @cut(2026-10-04) — not needed

\`\`\`
- [ ] {X} inside a code fence, ignored
\`\`\`
- [ ] no id here ~XL
`;

test('parses stage, tags, sizes, and leaf-only structure', () => {
  const r = parseRoadmap(MD);
  assert.equal(r.stage, 'beta');
  const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.equal(by.A.done, '2026-10-01');
  assert.equal(by.A.points, 1);
  assert.equal(by.B.leaf, false);
  assert.equal(by['B.1'].parent, 'B');
  assert.equal(by['B.2'].size, 'M');
  assert.equal(by.C.status, 'cut');
  assert.equal(by.C.title, 'Themes — not needed');
  assert.ok(!('X' in by));
  assert.ok(r.warnings.some((w) => w.includes('no {ID}')));
});

test('totals count leaves only and exclude cut items from scope', () => {
  // leaves: A(1, done), B.1(2, done), B.2(2), C(4, cut), no-id(8)
  assert.deepEqual(totals(parseRoadmap(MD)), { scope: 13, done: 3, cut: 4, openItems: 2, doneItems: 2 });
});

const snap = (date: string, md: string): Snapshot => ({ ts: Date.parse(`${date}T12:00:00`), source: 'git', commit: null, roadmap: parseRoadmap(md) });

test('burn-up records what was added, completed and cut each day', () => {
  const s1 = snap('2026-10-01', '- [ ] {A} a\n- [ ] {B} b');
  const s2 = snap('2026-10-02', '- [x] {A} a\n- [-] {B} b\n- [ ] {C} c ~L');
  const pts = burnup([s1, s2]);
  assert.deepEqual(pts.map((p) => [p.date, p.scope, p.done]), [['2026-10-01', 4, 0], ['2026-10-02', 6, 2]]);
  assert.deepEqual([pts[1].added, pts[1].completed, pts[1].cutItems], [['C'], ['A'], ['B']]);
});

test('missing dates are filled from the first snapshot showing the state', () => {
  const s1 = snap('2026-09-20', '- [ ] {A} a');
  const s2 = snap('2026-09-25', '- [x] {A} a');
  const [t] = timelines([s1, s2], '2026-10-01');
  assert.deepEqual([t.decided, t.done, t.leadDays], ['2026-09-20', '2026-09-25', 5]);
});

test('growth ratio compares scope added to work done over 14 days', () => {
  const s1 = snap('2026-09-10', '- [ ] {A} a\n- [ ] {B} b');
  const s2 = snap('2026-09-30', '- [x] {A} a\n- [ ] {B} b\n- [ ] {C} c ~L\n- [ ] {D} d ~L');
  const sum = summarize([s1, s2], '2026-10-01')!;
  assert.equal(sum.scopeAdded14d, 8);
  assert.equal(sum.done14d, 2);
  assert.equal(sum.growthRatio, 4);
  assert.deepEqual(sum.waiting.map((t) => t.item.key), ['B', 'C', 'D']);
});

test('date tags rebuild past states before the first recorded snapshot', async () => {
  const { snapshotsFromTags } = await import('../src/history.ts');
  const r = parseRoadmap('- [x] {A} a @decided(2026-09-01) @done(2026-09-03)\n- [-] {B} b @decided(2026-09-02) @cut(2026-09-04)\n- [ ] {C} c');
  const snaps = snapshotsFromTags(r, Date.parse('2026-10-01T00:00:00'));
  assert.deepEqual(burnup(snaps).map((p) => [p.date, p.scope, p.done, p.cut]), [
    ['2026-09-01', 4, 0, 0],
    ['2026-09-02', 6, 0, 0],
    ['2026-09-03', 6, 2, 0],
    ['2026-09-04', 4, 2, 2],
  ]);
});
