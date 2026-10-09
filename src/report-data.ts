// The data embedded in the dashboard. Numbers, project names and roadmap item titles only:
// no conversation text, commands or file contents.
import * as path from 'node:path';
import { attribute, UNATTRIBUTED } from './attribute.ts';
import { analyzeProjects, discoverRoadmapRoots } from './analyze.ts';
import type { Config } from './config.ts';
import { burnup, type BurnPoint, type DoneMix } from './history.ts';
import { buildCostIndex, resolveSamples, windowStatus, type WindowStatus } from './limits.ts';
import type { UsageRecord } from './logs.ts';
import { costOf, normalizeModel, type PriceTable } from './prices.ts';
import type { Status } from './roadmap.ts';
import { readSamples } from './statusline.ts';

export interface ReportItem {
  key: string;
  title: string;
  group: string | null;
  parent: string | null;
  status: Status;
  size: string;
  points: number;
  decided: string | null;
  start: string | null;
  paused: string | null;
  done: string | null;
  cut: string | null;
  leadDays: number | null;
  ageDays: number | null;
  usd: number;
  usdViaCommits: number;
}

export interface ReportProject {
  key: string;
  name: string;
  stage: string | null;
  scope: number;
  done: number;
  cut: number;
  openItems: number;
  growthRatio: number | null;
  scopeAdded14d: number;
  done14d: number;
  medianLeadDays: number | null;
  doneMix: DoneMix;
  burnup: BurnPoint[];
  items: ReportItem[];
  spend: { total: number; outside: number; taggedCommits: number };
  usdPerPoint: number | null;
  rateBasis: 'project' | 'all-projects' | null;
  lastActive: number | null;
  warnings: string[];
}

export interface ReportData {
  version: 1;
  generatedAt: number;
  config: Pick<Config, 'billing' | 'plan' | 'monthlyFeeUsd' | 'currency' | 'ratePerUsd'>;
  prices: { source: string; checked: string; unpriced: string[] };
  /** dimension tables; daily rows reference them by index */
  dims: { projects: string[]; models: string[] };
  /** [dayIndexSinceEpochLocal (YYYY-MM-DD), projectIdx, modelIdx, imported 0|1, usd, tokens] */
  daily: [string, number, number, 0 | 1, number, number][];
  projects: ReportProject[];
  limits: { five: WindowStatus | null; week: WindowStatus | null; samples: number };
}

const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export function buildReportData(records: UsageRecord[], prices: PriceTable, cfg: Config): ReportData {
  const usage = attribute(records);

  // Daily spend by project × model × imported.
  const projectNames: string[] = [];
  const projectIdx = new Map<string, number>();
  const models: string[] = [];
  const modelIdx = new Map<string, number>();
  const idx = <K>(m: Map<K, number>, list: K[], k: K) => {
    let i = m.get(k);
    if (i === undefined) {
      i = list.length;
      list.push(k);
      m.set(k, i);
    }
    return i;
  };
  const agg = new Map<string, [string, number, number, 0 | 1, number, number]>();
  const unpriced = new Set<string>();
  for (const a of usage) {
    const r = a.rec;
    const usd = costOf(prices, r.model, r.usage);
    if (usd === null) unpriced.add(normalizeModel(r.model));
    const tok = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
    const day = localDay(r.ts);
    const mi = idx(modelIdx, models, normalizeModel(r.model));
    const imp: 0 | 1 = r.entrypoint ? 0 : 1;
    for (const s of a.shares) {
      const name = s.repo === UNATTRIBUTED ? UNATTRIBUTED : s.repo;
      const pi = idx(projectIdx, projectNames, name);
      const k = `${day}|${pi}|${mi}|${imp}`;
      let row = agg.get(k);
      if (!row) agg.set(k, (row = [day, pi, mi, imp, 0, 0]));
      row[4] += (usd ?? 0) * s.weight;
      row[5] += tok * s.weight;
    }
  }
  const daily = [...agg.values()].map((r) => [r[0], r[1], r[2], r[3], round(r[4]), Math.round(r[5])] as typeof r).sort((a, b) => a[0].localeCompare(b[0]));

  const analyses = analyzeProjects(discoverRoadmapRoots(records), records, prices, usage);
  const projects: ReportProject[] = analyses.map((p) => ({
    key: p.root,
    name: path.basename(p.root),
    stage: p.sum.stage,
    scope: p.sum.now.scope,
    done: p.sum.now.done,
    cut: p.sum.now.cut,
    openItems: p.sum.now.openItems,
    growthRatio: p.sum.growthRatio,
    scopeAdded14d: p.sum.scopeAdded14d,
    done14d: p.sum.done14d,
    medianLeadDays: p.sum.medianLeadDays,
    doneMix: p.sum.doneMix,
    burnup: burnup(p.snaps),
    items: p.tl.map((t) => {
      const c = p.costs.byItem.get(t.item.key);
      return {
        key: t.item.key,
        title: t.item.title,
        group: t.item.group,
        parent: t.item.parent,
        status: t.item.status,
        size: t.item.size,
        points: t.item.points,
        decided: t.decided,
        start: t.start,
        paused: t.item.paused,
        done: t.done,
        cut: t.cut,
        leadDays: t.leadDays,
        ageDays: t.ageDays,
        usd: round(c?.usd ?? 0),
        usdViaCommits: round(c?.viaCommits ?? 0),
      };
    }),
    spend: { total: round(p.costs.total.usd), outside: round(p.costs.outside.usd), taggedCommits: p.costs.taggedCommits },
    usdPerPoint: p.proj ? round(p.proj.usdPerPoint) : null,
    rateBasis: p.proj?.basis ?? null,
    lastActive: p.lastActive,
    warnings: p.sum.warnings,
  }));

  const ix = buildCostIndex(records, prices);
  const samples = resolveSamples(ix, readSamples());
  return {
    version: 1,
    generatedAt: Date.now(),
    config: { billing: cfg.billing, plan: cfg.plan, monthlyFeeUsd: cfg.monthlyFeeUsd, currency: cfg.currency, ratePerUsd: cfg.ratePerUsd },
    prices: { source: prices.source, checked: prices.checked, unpriced: [...unpriced] },
    dims: { projects: projectNames.map((p) => (p === UNATTRIBUTED ? p : path.basename(p))), models },
    daily,
    projects,
    limits: { five: windowStatus(ix, samples, 'five'), week: windowStatus(ix, samples, 'week'), samples: samples.length },
  };
}
