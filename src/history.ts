// Builds the burn-up and per-item timelines from the git history of ROADMAP.md.
// Every commit that touched the file is a snapshot; the working-tree copy is the final one.
// Optional backfill snapshots (made once by `init` from older status docs) come first.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { dataDir } from './cache.ts';
import { parseRoadmap, totals, type Item, type Roadmap, type Stage, type Status, type Totals } from './roadmap.ts';

export const ROADMAP_FILE = 'ROADMAP.md';

export interface Snapshot {
  /** epoch ms */
  ts: number;
  source: 'tags' | 'backfill' | 'git' | 'working-tree';
  commit: string | null;
  roadmap: Roadmap;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function backfillFile(repo: string): string {
  const name = path.basename(repo).replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return path.join(dataDir(), 'backfill', `${name}.jsonl`);
}

function backfillSnapshots(repo: string): Snapshot[] {
  const f = backfillFile(repo);
  if (!existsSync(f)) return [];
  const out: Snapshot[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const { date, markdown } = JSON.parse(line) as { date: string; markdown: string };
      out.push({ ts: Date.parse(`${date}T23:59:00`), source: 'backfill', commit: null, roadmap: parseRoadmap(markdown) });
    } catch {}
  }
  return out;
}

/**
 * Rebuilds past states from the date tags in a roadmap, one snapshot per tagged date before `before`.
 * This gives a burn-up from day one when a ROADMAP.md is first written with dates filled in.
 * Items without @decided are treated as present from the earliest date.
 */
export function snapshotsFromTags(r: Roadmap, before: number): Snapshot[] {
  const dates = new Set<string>();
  for (const it of r.items) for (const d of [it.decided, it.start, it.done, it.cut]) if (d) dates.add(d);
  const sorted = [...dates].filter((d) => Date.parse(`${d}T23:59:00`) < before).sort();
  return sorted.map((d) => {
    const items = r.items
      .filter((it) => !it.decided || it.decided <= d)
      .map((it) => {
        const status: Status = it.cut && it.cut <= d ? 'cut' : it.done && it.done <= d ? 'done' : 'open';
        return { ...it, status };
      });
    return { ts: Date.parse(`${d}T23:59:00`), source: 'tags' as const, commit: null, roadmap: { ...r, items } };
  });
}

export function snapshots(repo: string): Snapshot[] {
  const out = collectSnapshots(repo);
  if (!out.length) return out;
  // Before the first recorded snapshot, fall back to what the date tags imply.
  const first = out[0];
  const latest = out[out.length - 1].roadmap;
  return [...snapshotsFromTags(latest, Math.min(first.ts, Date.parse(`${day(first.ts)}T00:00:00`))), ...out];
}

function collectSnapshots(repo: string): Snapshot[] {
  const out = backfillSnapshots(repo);
  let log = '';
  try {
    log = git(repo, ['log', '--follow', '--format=%H %ct', '--', ROADMAP_FILE]);
  } catch {}
  const commits = log
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '))
    .reverse();
  for (const [hash, ct] of commits) {
    try {
      const md = git(repo, ['show', `${hash}:${ROADMAP_FILE}`]);
      out.push({ ts: Number(ct) * 1000, source: 'git', commit: hash, roadmap: parseRoadmap(md) });
    } catch {} // renamed paths under --follow; skip what can't be shown
  }
  const wt = path.join(repo, ROADMAP_FILE);
  if (existsSync(wt)) {
    const md = readFileSync(wt, 'utf8');
    const last = out[out.length - 1];
    const lastMd = last?.commit ? safeShow(repo, last.commit) : null;
    if (md !== lastMd) out.push({ ts: Date.now(), source: 'working-tree', commit: null, roadmap: parseRoadmap(md) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function safeShow(repo: string, hash: string): string | null {
  try {
    return git(repo, ['show', `${hash}:${ROADMAP_FILE}`]);
  } catch {
    return null;
  }
}

const day = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface BurnPoint extends Totals {
  date: string;
  added: string[];
  completed: string[];
  cutItems: string[];
}

/** One point per day (the day's last snapshot), with what changed since the previous point. */
export function burnup(snaps: Snapshot[]): BurnPoint[] {
  const byDay = new Map<string, Snapshot>();
  for (const s of snaps) byDay.set(day(s.ts), s);
  const out: BurnPoint[] = [];
  let prev = new Map<string, Status>();
  for (const [date, s] of byDay) {
    const cur = new Map<string, Status>();
    for (const it of s.roadmap.items) if (it.leaf) cur.set(it.key, it.status);
    const added: string[] = [];
    const completed: string[] = [];
    const cutItems: string[] = [];
    for (const [k, st] of cur) {
      const was = prev.get(k);
      if (was === undefined && st !== 'cut') added.push(k);
      if (st === 'done' && was !== 'done') completed.push(k);
      if (st === 'cut' && was !== 'cut') cutItems.push(k);
    }
    out.push({ date, ...totals(s.roadmap), added, completed, cutItems });
    prev = cur;
  }
  return out;
}

export interface ItemTimeline {
  item: Item;
  /** dates resolved from tags first, then from the snapshot where the state first appeared */
  decided: string | null;
  start: string | null;
  done: string | null;
  cut: string | null;
  firstSeen: string;
  /** done - decided in days, for finished items */
  leadDays: number | null;
  /** today - decided in days, for open items */
  ageDays: number | null;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function timelines(snaps: Snapshot[], today = day(Date.now())): ItemTimeline[] {
  if (!snaps.length) return [];
  const firstSeen = new Map<string, string>();
  const firstDone = new Map<string, string>();
  const firstCut = new Map<string, string>();
  for (const s of snaps) {
    const d = day(s.ts);
    for (const it of s.roadmap.items) {
      if (!firstSeen.has(it.key)) firstSeen.set(it.key, d);
      if (it.status === 'done' && !firstDone.has(it.key)) firstDone.set(it.key, d);
      if (it.status === 'cut' && !firstCut.has(it.key)) firstCut.set(it.key, d);
    }
  }
  const latest = snaps[snaps.length - 1].roadmap;
  return latest.items
    .filter((it) => it.leaf)
    .map((item) => {
      const seen = firstSeen.get(item.key)!;
      const decided = item.decided ?? seen;
      const done = item.status === 'done' ? (item.done ?? firstDone.get(item.key) ?? null) : null;
      const cut = item.status === 'cut' ? (item.cut ?? firstCut.get(item.key) ?? null) : null;
      return {
        item,
        decided,
        start: item.start,
        done,
        cut,
        firstSeen: seen,
        leadDays: done ? daysBetween(decided, done) : null,
        ageDays: item.status === 'open' ? daysBetween(decided, today) : null,
      };
    });
}

/** Work picked up within this many days of being added counts as reactive (it wasn't planned ahead). */
export const REACTIVE_DAYS = 1;
export const MIX_WINDOW_DAYS = 30;

export interface DoneMix {
  windowDays: number;
  /** points finished in the window that were on the roadmap more than REACTIVE_DAYS before work began */
  planned: number;
  /** points finished in the window that were added and taken up almost at once */
  reactive: number;
  reactiveItems: string[];
}

/** Split recently finished work into planned-ahead vs picked-up-at-once, by points. */
export function doneMix(tl: ItemTimeline[], today: string, windowDays = MIX_WINDOW_DAYS): DoneMix {
  const from = day(Date.parse(today) - (windowDays - 1) * 86_400_000);
  const mix: DoneMix = { windowDays, planned: 0, reactive: 0, reactiveItems: [] };
  for (const t of tl) {
    if (!t.done || t.done < from || !t.decided) continue;
    // First seen already finished and no @decided: when it was planned is unknown, so it says nothing either way.
    if (!t.item.decided && t.firstSeen === t.done) continue;
    const begin = t.start ?? t.done;
    if (daysBetween(t.decided, begin) <= REACTIVE_DAYS) {
      mix.reactive += t.item.points;
      mix.reactiveItems.push(t.item.key);
    } else mix.planned += t.item.points;
  }
  return mix;
}

export interface ProgressSummary {
  stage: Stage | null;
  now: Totals;
  /** scope added ÷ points completed over the last 14 days; > 1 means the finish line is moving away */
  growthRatio: number | null;
  scopeAdded14d: number;
  done14d: number;
  medianLeadDays: number | null;
  doneMix: DoneMix;
  /** open, decided, not started, oldest first */
  waiting: ItemTimeline[];
  /** started but not finished */
  inProgress: ItemTimeline[];
  /** started, then paused (waiting on something) */
  paused: ItemTimeline[];
  warnings: string[];
}

export function summarize(snaps: Snapshot[], today = day(Date.now())): ProgressSummary | null {
  if (!snaps.length) return null;
  const pts = burnup(snaps);
  const latest = snaps[snaps.length - 1].roadmap;
  const now = totals(latest);
  const cutoff = day(Date.parse(today) - 14 * 86_400_000);
  const base = [...pts].reverse().find((p) => p.date <= cutoff) ?? null;
  const scopeAdded14d = base ? now.scope - base.scope : 0;
  const done14d = base ? now.done - base.done : 0;
  const tl = timelines(snaps, today);
  const leads = tl.map((t) => t.leadDays).filter((x): x is number => x != null).sort((a, b) => a - b);
  return {
    stage: latest.stage,
    now,
    growthRatio: base && done14d > 0 ? scopeAdded14d / done14d : null,
    scopeAdded14d,
    done14d,
    medianLeadDays: leads.length ? leads[leads.length >> 1] : null,
    doneMix: doneMix(tl, today),
    waiting: tl.filter((t) => t.item.status === 'open' && !t.start && !t.item.paused).sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)),
    inProgress: tl.filter((t) => t.item.status === 'open' && t.start && !t.item.paused),
    paused: tl.filter((t) => t.item.status === 'open' && t.item.paused),
    warnings: latest.warnings,
  };
}
