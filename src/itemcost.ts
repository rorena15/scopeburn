// Splits a project's Claude usage across its roadmap items, and projects the cost of what's left.
//
// Two rules, in priority order:
//  1. Commit tags: a commit whose message mentions {ID} claims the project's usage since the
//     previous commit (split by points when it names several items).
//  2. Intervals: otherwise, usage at time t goes to the leaf items in progress at t
//     (from @start, or @decided for finished items without one, until done/cut/paused), split by points.
// Usage that matches neither is "outside the roadmap".
import { execFileSync } from 'node:child_process';
import type { Attributed } from './attribute.ts';
import type { ItemTimeline } from './history.ts';
import { costOf, type PriceTable } from './prices.ts';

export interface Spend {
  usd: number;
  tokens: number;
}

export interface ItemCosts {
  byItem: Map<string, Spend & { viaCommits: number }>;
  outside: Spend;
  total: Spend;
  taggedCommits: number;
}

const dayStart = (d: string) => Date.parse(`${d}T00:00:00`);
const dayEnd = (d: string) => Date.parse(`${d}T23:59:59.999`);

interface Interval {
  key: string;
  points: number;
  from: number;
  to: number;
}

function intervals(tl: ItemTimeline[]): Interval[] {
  const out: Interval[] = [];
  for (const t of tl) {
    // Finished items without @start are assumed worked on since they were decided; cut ones are not.
    const begin = t.start ?? (t.done ? t.decided : null);
    if (!begin) continue; // never started: nothing to bill
    const end = t.done ?? t.cut ?? t.item.paused;
    out.push({ key: t.item.key, points: t.item.points, from: dayStart(begin), to: end ? dayEnd(end) : Infinity });
  }
  return out;
}

interface CommitWindow {
  from: number;
  to: number;
  keys: string[];
}

/** Commits mentioning known {ID}s, each claiming (previous commit, this commit]. */
export function commitWindows(repo: string, known: Map<string, number>): CommitWindow[] {
  let log = '';
  try {
    log = execFileSync('git', ['-C', repo, 'log', '--format=%x1e%ct%n%B'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const commits = log
    .split('\x1e')
    .filter(Boolean)
    .map((c) => {
      const nl = c.indexOf('\n');
      return { ts: Number(c.slice(0, nl)) * 1000, msg: c.slice(nl + 1) };
    })
    .sort((a, b) => a.ts - b.ts);
  const out: CommitWindow[] = [];
  for (let i = 0; i < commits.length; i++) {
    const keys = [...new Set([...commits[i].msg.matchAll(/\{([^}\s]+)\}/g)].map((m) => m[1]).filter((k) => known.has(k)))];
    if (keys.length) out.push({ from: i ? commits[i - 1].ts : 0, to: commits[i].ts, keys });
  }
  return out;
}

export function itemCosts(repo: string, usage: Attributed[], tl: ItemTimeline[], prices: PriceTable): ItemCosts {
  const points = new Map(tl.map((t) => [t.item.key, t.item.points]));
  const ivs = intervals(tl);
  const windows = commitWindows(repo, points);
  const byItem = new Map<string, Spend & { viaCommits: number }>();
  const outside: Spend = { usd: 0, tokens: 0 };
  const total: Spend = { usd: 0, tokens: 0 };
  const give = (key: string, usd: number, tokens: number, viaCommit: boolean) => {
    let s = byItem.get(key);
    if (!s) byItem.set(key, (s = { usd: 0, tokens: 0, viaCommits: 0 }));
    s.usd += usd;
    s.tokens += tokens;
    if (viaCommit) s.viaCommits += usd;
  };
  const split = (keys: string[], usd: number, tok: number, viaCommit: boolean) => {
    const sum = keys.reduce((s, k) => s + (points.get(k) ?? 1), 0);
    for (const k of keys) {
      const w = (points.get(k) ?? 1) / sum;
      give(k, usd * w, tok * w, viaCommit);
    }
  };

  for (const a of usage) {
    const share = a.shares.find((s) => s.repo === repo);
    if (!share) continue;
    const u = a.rec.usage;
    const usd = (costOf(prices, a.rec.model, u) ?? 0) * share.weight;
    const tok = (u.input + u.output + u.cacheRead + u.cacheWrite) * share.weight;
    total.usd += usd;
    total.tokens += tok;
    const t = a.rec.ts;
    const win = windows.find((w) => w.from < t && t <= w.to);
    if (win) {
      split(win.keys, usd, tok, true);
      continue;
    }
    const active = ivs.filter((iv) => iv.from <= t && t <= iv.to).map((iv) => iv.key);
    if (active.length) split(active, usd, tok, false);
    else {
      outside.usd += usd;
      outside.tokens += tok;
    }
  }
  return { byItem, outside, total, taggedCommits: windows.length };
}

export interface Projection {
  remainingPoints: number;
  /** USD per point, from this project's finished items, or the fallback rate */
  usdPerPoint: number;
  basis: 'project' | 'all-projects';
  basedOnItems: number;
  usd: number;
}

/** Cost of the remaining open points, at the median cost per point of finished items. */
export function project(tl: ItemTimeline[], costs: ItemCosts, fallbackUsdPerPoint: number | null): Projection | null {
  const rates: number[] = [];
  for (const t of tl) {
    if (t.item.status !== 'done') continue;
    const s = costs.byItem.get(t.item.key);
    if (s && s.usd > 0) rates.push(s.usd / t.item.points);
  }
  const remainingPoints = tl.filter((t) => t.item.status === 'open').reduce((s, t) => s + t.item.points, 0);
  rates.sort((a, b) => a - b);
  const own = rates.length >= 5 ? rates[rates.length >> 1] : null;
  const rate = own ?? fallbackUsdPerPoint;
  if (rate == null) return null;
  return {
    remainingPoints,
    usdPerPoint: rate,
    basis: own != null ? 'project' : 'all-projects',
    basedOnItems: rates.length,
    usd: remainingPoints * rate,
  };
}

/** Per-point rates of finished items, for pooling across projects. */
export function finishedRates(tl: ItemTimeline[], costs: ItemCosts): number[] {
  return tl
    .filter((t) => t.item.status === 'done')
    .map((t) => (costs.byItem.get(t.item.key)?.usd ?? 0) / t.item.points)
    .filter((r) => r > 0);
}
