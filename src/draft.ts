// Drafts a ROADMAP.md from git history without an LLM: commits grouped by topic become items,
// and unchecked "- [ ]" lines in the repo's docs become open items.
// It's a starting point to review, not an answer. The skill path (Claude reading the docs) does better.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface Commit {
  ts: number;
  subject: string;
}

const SKIP_TYPES = new Set(['docs', 'doc', 'chore', 'ci', 'build', 'style', 'test', 'tests', 'revert', 'release', 'wip']);
const FIX_TYPES = new Set(['fix', 'hotfix', 'bugfix']);
// First words too generic to name a topic on their own.
const GENERIC = new Set(['웹', '앱', 'ui', 'ux', '화면', '새', '기능', '전체', 'add', 'update', 'new', 'the', 'a', 'initial', 'improve', 'make', 'support', 'use']);
const PARTICLE = /(에서|으로|에게|까지|부터|에|을|를|은|는|이|가|의|과|와|로|도)$/;

interface Parsed {
  type: string | null;
  scope: string | null;
  rest: string;
}

export function parseSubject(subject: string): Parsed {
  const conv = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.*)$/i.exec(subject);
  if (conv) return { type: conv[1].toLowerCase(), scope: conv[2]?.trim() || null, rest: conv[3] };
  // "2막 G단계: ..." — a short label before a colon works as a scope.
  const label = /^([^:]{2,24}):\s+(.*)$/.exec(subject);
  if (label && !/[.!?]/.test(label[1])) return { type: null, scope: label[1].trim(), rest: label[2] };
  return { type: null, scope: null, rest: subject };
}

/** The head of a subject, before details: "i18n 문자열 분리(31차) — 에러…" → "i18n 문자열 분리". */
export function topicOf(rest: string): string {
  return rest
    .split(/\s[—–-]\s|[:(（,+·]|\s\/\s/)[0]
    .replace(/\d+\s*(차|번째|단계)?\s*$/, '')
    .trim();
}

function keyOf(p: Parsed): string {
  if (p.scope) return p.scope.replace(/\s*\d+$/, '').toLowerCase();
  const words = topicOf(p.rest)
    .split(/\s+/)
    .map((w) => w.replace(PARTICLE, '').toLowerCase())
    .filter(Boolean);
  if (!words.length) return '';
  return GENERIC.has(words[0]) && words[1] ? `${words[0]} ${words[1]}` : words[0];
}

const day = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const sizeFor = (n: number) => (n >= 10 ? 'XL' : n >= 4 ? 'L' : n >= 2 ? 'M' : 'S');

function idFor(key: string, used: Set<string>): string {
  let base =
    key
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'item';
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}

export interface Todo {
  text: string;
  file: string;
}

export interface DraftOptions {
  name: string;
  today: string;
  /** commits in the last N days still count as in progress */
  activeDays?: number;
  maxItems?: number;
}

export function draftRoadmap(commits: Commit[], todos: Todo[], o: DraftOptions): string {
  const ko = commits.filter((c) => /[가-힣]/.test(c.subject)).length > commits.length * 0.3 || todos.some((t) => /[가-힣]/.test(t.text));
  const L = ko
    ? { inProgress: '진행 중', todo: '할 일 (문서에서 가져옴)', note: '초안: scopeburn이 git 기록으로 묶었어요. 항목 이름·크기·묶음을 고치고, 하지 않을 일은 [-]로 표시하세요.' }
    : { inProgress: 'In progress', todo: 'To do (from docs)', note: 'Draft: grouped from git history by scopeburn. Rename, resize and regroup items; mark dropped ones [-].' };
  const activeFrom = Date.parse(`${o.today}T00:00:00`) - (o.activeDays ?? 3) * 86_400_000;

  interface Group {
    key: string;
    title: string;
    first: number;
    last: number;
    n: number;
    features: number;
  }
  const groups = new Map<string, Group>();
  const sorted = [...commits].sort((a, b) => a.ts - b.ts);
  const pending: [string, Commit][] = [];
  for (const c of sorted) {
    const p = parseSubject(c.subject);
    if (p.type && SKIP_TYPES.has(p.type)) continue;
    if (/^merge\b/i.test(c.subject)) continue;
    const key = keyOf(p);
    if (!key) continue;
    if (p.type && FIX_TYPES.has(p.type)) {
      pending.push([key, c]); // fixes only count toward a topic that has real work
      continue;
    }
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, title: p.scope ?? topicOf(p.rest), first: c.ts, last: c.ts, n: 0, features: 0 }));
    g.n++;
    g.features++;
    g.last = Math.max(g.last, c.ts);
    // the shortest head makes the cleanest title
    const t = p.scope ?? topicOf(p.rest);
    if (!p.scope && t.length >= 4 && t.length < g.title.length) g.title = t;
  }
  for (const [key, c] of pending) {
    const g = groups.get(key);
    if (g && c.ts >= g.first) {
      g.n++;
      g.last = Math.max(g.last, c.ts);
    }
  }

  const items = [...groups.values()].sort((a, b) => b.last - a.last).slice(0, o.maxItems ?? 40);
  const used = new Set<string>();
  const active = items.filter((g) => g.last >= activeFrom);
  const done = items.filter((g) => g.last < activeFrom);
  const line = (g: Group, open: boolean) =>
    `- [${open ? ' ' : 'x'}] {${idFor(g.key, used)}} ${g.title} ~${sizeFor(g.n)} @decided(${day(g.first)})` +
    (open ? ` @start(${day(g.first)})` : ` @done(${day(g.last)})`);

  const out: string[] = [`# ROADMAP · ${o.name}`, 'stage: prototype', '', '<!--', `  ${L.note}`, '  - [ ] / [x] / [-]   {ID}   ~S ~M ~L ~XL   @decided @start @paused @done @cut', '-->', ''];
  if (active.length) {
    out.push(`## ${L.inProgress}`);
    for (const g of active) out.push(line(g, true));
    out.push('');
  }
  // finished work, newest month first
  const byMonth = new Map<string, Group[]>();
  for (const g of done) {
    const m = day(g.last).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(g);
  }
  for (const [m, gs] of [...byMonth].sort((a, b) => b[0].localeCompare(a[0]))) {
    out.push(`## ${m}`);
    for (const g of gs.sort((a, b) => a.last - b.last)) out.push(line(g, false));
    out.push('');
  }
  if (todos.length) {
    out.push(`## ${L.todo}`);
    for (const t of todos) out.push(`- [ ] {${idFor(topicOf(t.text) || 'todo', used)}} ${t.text} @decided(${o.today})`);
    out.push('');
  }
  return out.join('\n');
}

export function gitCommits(repo: string, days: number): Commit[] {
  try {
    const log = execFileSync('git', ['-C', repo, 'log', `--since=${days}.days`, '--no-merges', '--format=%ct%x09%s'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('\t');
        return { ts: Number(l.slice(0, i)) * 1000, subject: l.slice(i + 1) };
      });
  } catch {
    return [];
  }
}

/** Unchecked "- [ ]" lines from markdown files at the repo root and one level under docs/. */
export function docTodos(repo: string, max = 30): Todo[] {
  const files: string[] = [];
  const add = (dir: string) => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && /\.md$/i.test(e.name) && !/^(ROADMAP|CHANGELOG|LICENSE)/i.test(e.name)) files.push(path.join(dir, e.name));
      }
    } catch {}
  };
  add(repo);
  const docs = path.join(repo, 'docs');
  if (existsSync(docs)) add(docs);
  const out: Todo[] = [];
  for (const f of files) {
    let inFence = false;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) continue;
      const m = /^\s*[-*] \[ \]\s+(.+)$/.exec(line);
      if (m) out.push({ text: m[1].replace(/\s+/g, ' ').trim().slice(0, 120), file: path.relative(repo, f) });
      if (out.length >= max) return out;
    }
  }
  return out;
}
