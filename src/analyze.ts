// Per-project analysis shared by the `roadmap` command and the dashboard.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { attribute, type Attributed } from './attribute.ts';
import { ROADMAP_FILE, snapshots, summarize, timelines, type ItemTimeline, type ProgressSummary, type Snapshot } from './history.ts';
import { finishedRates, itemCosts, project, type ItemCosts, type Projection } from './itemcost.ts';
import type { UsageRecord } from './logs.ts';
import type { PriceTable } from './prices.ts';
import { repoRootOfPath } from './repo.ts';

export interface ProjectAnalysis {
  root: string;
  snaps: Snapshot[];
  sum: ProgressSummary;
  tl: ItemTimeline[];
  costs: ItemCosts;
  proj: Projection | null;
  lastActive: number | null;
}

/** Every project seen in the logs (plus cwd) that has a ROADMAP.md. */
export function discoverRoadmapRoots(records: UsageRecord[]): string[] {
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r.repos)) seen.add(k);
    if (r.cwdRepo) seen.add(r.cwdRepo);
  }
  const here = repoRootOfPath(process.cwd());
  if (here) seen.add(here);
  return [...seen].filter((r) => existsSync(path.join(r, ROADMAP_FILE))).sort();
}

export function lastActivity(usage: Attributed[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of usage) for (const s of it.shares) m.set(s.repo, Math.max(m.get(s.repo) ?? 0, it.rec.ts));
  return m;
}

export function analyzeProjects(roots: string[], records: UsageRecord[], prices: PriceTable, usage = attribute(records)): ProjectAnalysis[] {
  const last = lastActivity(usage);
  const base = roots.flatMap((root) => {
    const snaps = snapshots(root);
    const sum = summarize(snaps);
    if (!sum) return [];
    const tl = timelines(snaps);
    return [{ root, snaps, sum, tl, costs: itemCosts(root, usage, tl, prices), lastActive: last.get(root) ?? null }];
  });
  // Projects with fewer than 5 finished items borrow the median rate pooled across all projects.
  const pooled = base.flatMap((p) => finishedRates(p.tl, p.costs)).sort((a, b) => a - b);
  const fallback = pooled.length >= 5 ? pooled[pooled.length >> 1] : null;
  return base.map((p) => ({ ...p, proj: project(p.tl, p.costs, fallback) }));
}
