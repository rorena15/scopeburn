// Subscription limit windows (5-hour and weekly), cap estimation from calibration samples, and projections.
// The consumption unit is API-equivalent USD: limits drain faster on pricier models, which the
// price table roughly captures. Whether that holds is exactly what the calibration spread shows.
import type { UsageRecord } from './logs.ts';
import { costOf, type PriceTable } from './prices.ts';
import type { Sample } from './statusline.ts';

export const HOUR = 3_600_000;
export const FIVE_H = 5 * HOUR;
export const WEEK = 7 * 24 * HOUR;
const BURN_WINDOW = 45 * 60_000;

export interface CostIndex {
  ts: number[];
  /** prefix sums of cost, aligned with ts (cum[i] = cost of records 0..i-1) */
  cum: number[];
}

export function buildCostIndex(records: UsageRecord[], prices: PriceTable): CostIndex {
  const rows = records
    .map((r) => [r.ts, costOf(prices, r.model, r.usage) ?? 0] as const)
    .sort((a, b) => a[0] - b[0]);
  const ts: number[] = [];
  const cum = [0];
  for (const [t, c] of rows) {
    ts.push(t);
    cum.push(cum[cum.length - 1] + c);
  }
  return { ts, cum };
}

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Cost of responses with from <= ts < to. */
export function costBetween(ix: CostIndex, from: number, to: number): number {
  return ix.cum[lowerBound(ix.ts, to)] - ix.cum[lowerBound(ix.ts, from)];
}

/** 5h windows rebuilt from activity: a window opens at the first response (floored to the hour) after the last one closed. */
export function reconstructWindows(ix: CostIndex, length = FIVE_H): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const t of ix.ts) {
    const cur = out[out.length - 1];
    if (cur && t < cur.end) continue;
    const start = Math.floor(t / HOUR) * HOUR;
    out.push({ start, end: start + length });
  }
  return out;
}

export interface CapEstimate {
  /** median API-equivalent USD that equals 100% of the window */
  median: number;
  min: number;
  max: number;
  samples: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Each sample says "at time ts, pct% of the window was used". Pairing it with the local cost spent
 * since the window opened gives one estimate of the full cap. Usage outside this machine (web app,
 * other PCs) inflates pct without local cost, so estimates skew low; the min/max spread exposes that.
 */
export function estimateCap(
  ix: CostIndex,
  samples: Sample[],
  which: 'five' | 'week',
  minPct: number,
): CapEstimate | null {
  const length = which === 'five' ? FIVE_H : WEEK;
  const caps: number[] = [];
  for (const s of samples) {
    const w = s[which];
    if (!w || w.resetsAt == null || w.pct < minPct) continue;
    const spent = costBetween(ix, w.resetsAt - length, s.ts);
    if (spent > 0) caps.push(spent / (w.pct / 100));
  }
  if (!caps.length) return null;
  return { median: median(caps), min: Math.min(...caps), max: Math.max(...caps), samples: caps.length };
}

/** Manual samples have no reset time; place 5h ones in the window rebuilt from activity. */
export function resolveSamples(ix: CostIndex, samples: Sample[]): Sample[] {
  let windows: { start: number; end: number }[] | null = null;
  return samples.map((s) => {
    if (!s.five || s.five.resetsAt != null) return s;
    windows ??= reconstructWindows(ix);
    const w = windows.find((x) => x.start <= s.ts && s.ts < x.end);
    return w ? { ...s, five: { ...s.five, resetsAt: w.end } } : s;
  });
}

export interface WindowStatus {
  start: number;
  end: number;
  /** true when the boundaries come from Claude Code itself (resets_at), false when rebuilt from activity */
  exact: boolean;
  spent: number;
  /** latest reported usage percentage in this window, if any */
  reportedPct: number | null;
  reportedAt: number | null;
  cap: CapEstimate | null;
  /** USD per hour over the last 45 minutes */
  burnPerHour: number;
  /** estimated time the cap is reached at the current burn rate; null when it won't be within the window */
  hitsCapAt: number | null;
}

export function windowStatus(
  ix: CostIndex,
  samples: Sample[],
  which: 'five' | 'week',
  now = Date.now(),
): WindowStatus | null {
  const length = which === 'five' ? FIVE_H : WEEK;
  const latest = [...samples].reverse().find((s) => s[which]?.resetsAt && s[which]!.resetsAt! > now);
  let start: number;
  let end: number;
  let exact = false;
  if (latest) {
    end = latest[which]!.resetsAt!;
    start = end - length;
    exact = true;
  } else if (which === 'five') {
    const cur = reconstructWindows(ix).find((w) => w.start <= now && now < w.end);
    if (!cur) return null;
    ({ start, end } = cur);
  } else {
    return null; // the weekly reset point can't be inferred from activity alone
  }
  const spent = costBetween(ix, start, now);
  const inWindow = samples.filter((s) => s[which]?.resetsAt === end);
  const last = inWindow[inWindow.length - 1];
  const cap = estimateCap(ix, samples, which, which === 'five' ? 5 : 2);
  const burnPerHour = (costBetween(ix, now - BURN_WINDOW, now) / BURN_WINDOW) * HOUR;
  let hitsCapAt: number | null = null;
  if (cap && burnPerHour > 0) {
    // Prefer the reported percentage (it includes usage we can't see), else the local estimate.
    const used = last ? (last[which]!.pct / 100) * cap.median : spent;
    const t = now + ((cap.median - used) / burnPerHour) * HOUR;
    if (t < end) hitsCapAt = Math.max(now, t);
  }
  return {
    start,
    end,
    exact,
    spent,
    reportedPct: last ? last[which]!.pct : null,
    reportedAt: last ? last.ts : null,
    cap,
    burnPerHour,
    hitsCapAt,
  };
}
