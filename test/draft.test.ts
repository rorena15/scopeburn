import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftRoadmap, parseSubject, topicOf } from '../src/draft.ts';
import { parseRoadmap, totals } from '../src/roadmap.ts';

const at = (d: string) => Date.parse(`${d}T12:00:00`);

test('subjects: conventional, scoped, label-colon and plain', () => {
  assert.deepEqual(parseSubject('feat(2막 G단계): 적 레벨'), { type: 'feat', scope: '2막 G단계', rest: '적 레벨' });
  assert.deepEqual(parseSubject('fix: 버그'), { type: 'fix', scope: null, rest: '버그' });
  assert.deepEqual(parseSubject('2막 G단계: 밸런스 2차'), { type: null, scope: '2막 G단계', rest: '밸런스 2차' });
  assert.equal(parseSubject('웹 대시보드 개편: 설정 통합').scope, '웹 대시보드 개편');
  assert.equal(topicOf('i18n 문자열 분리(31차) — 에러 바운더리'), 'i18n 문자열 분리');
});

test('commits group by topic into sized items; docs/fix-only are skipped; recent work stays open', () => {
  const commits = [
    ...Array.from({ length: 12 }, (_, i) => ({ ts: at('2026-09-07'), subject: `feat: i18n 문자열 분리(${i + 1}차) — 화면 ${i}` })),
    { ts: at('2026-09-08'), subject: 'feat: i18n 마이그레이션 마무리' },
    { ts: at('2026-09-26'), subject: '관리자 화면에서 공지 관리' },
    { ts: at('2026-09-26'), subject: '관리자 메일 템플릿' },
    { ts: at('2026-09-27'), subject: 'fix: 관리자 화면 버그' },
    { ts: at('2026-09-27'), subject: 'fix: 혼자 있는 수정' },
    { ts: at('2026-09-28'), subject: 'docs: 문서 갱신' },
    { ts: at('2026-10-09'), subject: 'feat(2막 G단계): 적 레벨' },
    { ts: at('2026-10-09'), subject: 'feat(2막 G단계 2): 보스' },
  ];
  const md = draftRoadmap(commits, [{ text: '결과 필터 강화', file: 'docs/TODO.md' }], { name: 'demo', today: '2026-10-10' });
  const r = parseRoadmap(md);
  const by = Object.fromEntries(r.items.map((i) => [i.title, i]));
  assert.equal(by['i18n 문자열 분리'].size, 'XL'); // 13 commits on the i18n topic
  assert.equal(by['i18n 문자열 분리'].done, '2026-09-08');
  assert.equal(by['관리자 화면에서 공지 관리'] ?? by['관리자 메일 템플릿'] ? true : false, true);
  assert.equal(r.items.filter((i) => /관리자/.test(i.title)).length, 1, 'admin commits are one topic');
  assert.ok(!r.items.some((i) => /혼자|문서/.test(i.title)), 'fix-only and docs topics are dropped');
  const g = r.items.find((i) => i.title === '2막 G단계')!;
  assert.deepEqual([g.status, g.start, g.size], ['open', '2026-10-09', 'M']);
  assert.ok(r.items.some((i) => i.title === '결과 필터 강화' && i.status === 'open'));
  assert.ok(totals(r).scope > 0);
  assert.equal(r.warnings.length, 0);
});

test('prompt hook fires on planning/decision messages near a roadmap only', async () => {
  const { promptContext } = await import('../src/hook.ts');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const ws = mkdtempSync(path.join(os.tmpdir(), 'sb-ws-'));
  mkdirSync(path.join(ws, 'app'));
  writeFileSync(path.join(ws, 'app', 'ROADMAP.md'), '- [ ] {a} a');
  assert.match(promptContext('2막 보스 설계 이렇게 가자', ws) ?? '', /app.ROADMAP\.md/);
  assert.match(promptContext("let's plan the next milestone", ws) ?? '', /@decided\(/);
  assert.equal(promptContext('이 에러 뭐야?', ws), null);
  assert.equal(promptContext('설계해줘', os.tmpdir() + path.sep + 'nope-none'), null);
});
