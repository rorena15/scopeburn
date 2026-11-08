import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { splitItemTitle } from '../src/report-data.ts';
import { parseRoadmap } from '../src/roadmap.ts';
import type { ReportData } from '../src/report-data.ts';

const template = readFileSync(new URL('../src/report/template.html', import.meta.url), 'utf8');
const reportSource = readFileSync(new URL('../src/report.ts', import.meta.url), 'utf8').replace("import template from './report/template.html';", 'const template = ' + JSON.stringify(template) + ';');
const compiled = transformSync(reportSource, { loader: 'ts', format: 'esm', target: 'esnext' });
const { redact, renderHtml } = await import('data:text/javascript;base64,' + Buffer.from(compiled.code).toString('base64'));

test('report titles split at the first spaced em dash only', () => {
  assert.deepEqual(splitItemTitle('Title'), { title: 'Title', note: null });
  assert.deepEqual(splitItemTitle('Title — memo'), { title: 'Title', note: 'memo' });
  assert.deepEqual(splitItemTitle('Title — memo — context'), { title: 'Title', note: 'memo — context' });
  assert.deepEqual(splitItemTitle('Title—inline'), { title: 'Title—inline', note: null });
});

test('date tags in notes remain date fields and are removed from displayed notes', () => {
  const item = parseRoadmap('- [ ] {A} Title — memo @decided(2026-10-01) @start(2026-10-02) ~M').items[0];
  assert.equal(item.decided, '2026-10-01');
  assert.equal(item.start, '2026-10-02');
  assert.deepEqual(splitItemTitle(item.title), { title: 'Title', note: 'memo' });
  assert.deepEqual(splitItemTitle('Title — @paused(2026-10-03) memo @done(2026-10-04) @cut(2026-10-05)'), { title: 'Title', note: 'memo' });
});

test('redaction removes notes from data and HTML without mutating the original', () => {
  const data = { version: 1, generatedAt: 0, config: {}, dims: { projects: ['fake-project'], models: [] }, daily: [], projects: [{ key: '/fake', name: 'fake-project', warnings: [], burnup: [{ added: ['~PRIVATE_NOTE_8274'], completed: ['~PRIVATE_NOTE_8274'], cutItems: ['~PRIVATE_NOTE_8274'] }], doneMix: { reactiveItems: ['~PRIVATE_NOTE_8274'] }, items: [{ key: 'A', title: 'Title', note: 'PRIVATE_NOTE_8274', group: 'Group' }, { key: '~PRIVATE_NOTE_8274', title: 'Other', note: 'PRIVATE_NOTE_8274', group: null }] }], limits: { five: null, week: null, samples: 0 }, prices: { source: 'fake', checked: '', unpriced: [] } } as unknown as ReportData;
  const result = redact(data);
  assert.equal(result.projects[0].items[0].note, null);
  assert.equal(result.projects[0].items[1].note, null);
  assert.equal(data.projects[0].items[0].note, 'PRIVATE_NOTE_8274');
  const anonymousKey = result.projects[0].items[1].key;
  assert.equal(result.projects[0].burnup[0].added[0], anonymousKey);
  assert.equal(result.projects[0].burnup[0].completed[0], anonymousKey);
  assert.equal(result.projects[0].burnup[0].cutItems[0], anonymousKey);
  assert.equal(result.projects[0].doneMix.reactiveItems[0], anonymousKey);
  assert.ok(!renderHtml(result).includes('PRIVATE_NOTE_8274'));
  assert.ok(renderHtml(data).includes('PRIVATE_NOTE_8274'));
});

test('template dictionaries have matching keys and no empty translations', () => {
  for (const name of ['T', 'HELP']) {
    const declaration = template.match(new RegExp('const ' + name + ' = ([\\s\\S]*?);\\s*\\n'));
    assert.ok(declaration, name);
    const dict = runInNewContext('(' + declaration[1] + ')');
    const flatten = (v: any, prefix = ''): Record<string, string> => Object.fromEntries(Object.entries(v).flatMap(([k, x]) => typeof x === 'string' ? [[prefix + k, x]] : Object.entries(flatten(x, prefix + k + '.'))));
    const en = flatten(dict.en), ko = flatten(dict.ko);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort(), name);
    for (const [k, v] of Object.entries({ ...en, ...ko })) assert.ok(v.trim(), name + '.' + k);
    if (name === 'T') for (const match of template.matchAll(/(?:\bt\(['"]|data-i18n=")([\w]+)['"]/g)) assert.ok(match[1] in dict.en, match[1]);
  }
});

test('dashboard script parses and embedded JSON cannot terminate its script element', () => {
  const code = template.match(/<script>([\s\S]*?)<\/script>/)![1];
  assert.doesNotThrow(() => new Function(code));
  const html = renderHtml({ dims: { projects: ['</script><script>bad()</script>'] } } as ReportData);
  assert.ok(!html.includes('<script>bad()'));
});
