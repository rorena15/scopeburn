// Parses ROADMAP.md: a plain markdown checklist with a few optional inline tags.
//
//   stage: beta
//   ## Group
//   - [ ] {ID} Title ~L @decided(2026-10-01) @start(2026-10-02) @paused(2026-10-05)
//     - [x] {ID.1} Sub-item ~S @done(2026-10-03)
//   - [-] {ID2} Dropped item @cut(2026-10-04) — why
//
// Only leaf items count toward scope; parents just group. Every tag is optional: dates missing
// from the file are filled in from git history (the first snapshot where the state appeared).

export const STAGES = ['idea', 'prototype', 'mvp', 'beta', 'released', 'maintenance'] as const;
export type Stage = (typeof STAGES)[number];
export type Status = 'open' | 'done' | 'cut';

export const SIZE_POINTS = { S: 1, M: 2, L: 4, XL: 8 } as const;
export type Size = keyof typeof SIZE_POINTS;

export interface Item {
  /** {ID} when given, else a key derived from the title */
  key: string;
  hasId: boolean;
  title: string;
  group: string | null;
  status: Status;
  size: Size;
  points: number;
  decided: string | null;
  start: string | null;
  /** stopped being worked on (e.g. waiting on someone else); no usage is billed to it after this */
  paused: string | null;
  done: string | null;
  cut: string | null;
  parent: string | null;
  leaf: boolean;
  line: number;
}

export interface Roadmap {
  stage: Stage | null;
  items: Item[];
  warnings: string[];
}

const ITEM = /^(\s*)[-*+] \[( |x|X|-)\]\s+(.*)$/;
const TAG_DATE = /@(decided|start|paused|done|cut)\((\d{4}-\d{2}-\d{2})\)/g;
const SIZE = /(?:^|\s)~(XL|S|M|L)(?=\s|$)/;
const ID = /^\{([^}\s]+)\}\s*/;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

export function parseRoadmap(md: string): Roadmap {
  const warnings: string[] = [];
  const items: Item[] = [];
  let stage: Stage | null = null;
  let group: string | null = null;
  let inFence = false;
  // indentation stack of open parents: [indent, key]
  const stack: [number, string][] = [];
  const seen = new Set<string>();

  md.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const st = /^stage:\s*([a-z]+)\s*$/i.exec(raw);
    if (st) {
      const v = st[1].toLowerCase() as Stage;
      if ((STAGES as readonly string[]).includes(v)) stage = v;
      else warnings.push(`line ${line}: unknown stage "${st[1]}" (use ${STAGES.join(', ')})`);
      return;
    }
    const h = /^#{2,6}\s+(.*)$/.exec(raw);
    if (h) {
      group = h[1].trim();
      stack.length = 0;
      return;
    }
    const m = ITEM.exec(raw);
    if (!m) return;
    const indent = m[1].replace(/\t/g, '  ').length;
    let text = m[3];

    const idm = ID.exec(text);
    const hasId = !!idm;
    if (idm) text = text.slice(idm[0].length);

    const dates: Record<string, string> = {};
    text = text.replace(TAG_DATE, (_, k: string, d: string) => {
      dates[k] = d;
      return '';
    });
    const sm = SIZE.exec(text);
    const size: Size = (sm?.[1] as Size) ?? 'M';
    if (sm) text = text.replace(SIZE, ' ');
    const title = text.replace(/\s+/g, ' ').trim();

    let key = idm ? idm[1] : `~${slug(title)}`;
    if (!hasId) warnings.push(`line ${line}: no {ID} on "${title.slice(0, 40)}" — history tracking falls back to the title`);
    if (seen.has(key)) {
      warnings.push(`line ${line}: duplicate ID {${key}}`);
      key = `${key}#${line}`;
    }
    seen.add(key);

    while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1][1] : null;
    if (parent) {
      const p = items.find((it) => it.key === parent);
      if (p) p.leaf = false;
    }
    stack.push([indent, key]);

    const status: Status = m[2] === ' ' ? 'open' : m[2] === '-' ? 'cut' : 'done';
    items.push({
      key,
      hasId,
      title,
      group,
      status,
      size,
      points: SIZE_POINTS[size],
      decided: dates.decided ?? null,
      start: dates.start ?? null,
      paused: dates.paused ?? null,
      done: dates.done ?? null,
      cut: dates.cut ?? null,
      parent,
      leaf: true,
      line,
    });
  });
  return { stage, items, warnings };
}

export interface Totals {
  scope: number;
  done: number;
  cut: number;
  openItems: number;
  doneItems: number;
}

export function totals(r: Roadmap): Totals {
  const t: Totals = { scope: 0, done: 0, cut: 0, openItems: 0, doneItems: 0 };
  for (const it of r.items) {
    if (!it.leaf) continue;
    if (it.status === 'cut') {
      t.cut += it.points;
      continue;
    }
    t.scope += it.points;
    if (it.status === 'done') {
      t.done += it.points;
      t.doneItems++;
    } else t.openItems++;
  }
  return t;
}
