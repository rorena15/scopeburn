import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { attribute, UNATTRIBUTED, type Attributed, type Level } from './attribute.ts';
import { loadRecords } from './cache.ts';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { buildCostIndex, resolveSamples, windowStatus, type WindowStatus } from './limits.ts';
import { defaultLogRoots, listLogFiles, type Usage, type UsageRecord } from './logs.ts';
import { burnup, ROADMAP_FILE, snapshots, summarize } from './history.ts';
import { costOf, loadPrices, normalizeModel, type PriceTable } from './prices.ts';
import { repoRootOfPath } from './repo.ts';
import { appendSample, installStatusline, readSamples, statuslineMain, uninstallStatusline } from './statusline.ts';

interface Args {
  cmd: string;
  positional: string[];
  since: number;
  until: number;
  by: 'repo' | 'day' | 'model';
  json: boolean;
  noCache: boolean;
  /** drop sessions with no entrypoint (run elsewhere, imported into this machine's logs) */
  localOnly: boolean;
  opts: Record<string, string>;
}

function parseDate(s: string): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date: ${s} (use YYYY-MM-DD)`);
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime(); // local midnight
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: 'usage', positional: [], since: 0, until: Infinity, by: 'repo', json: false, noCache: false, localOnly: false, opts: {} };
  let days = 30;
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) a.cmd = rest.shift()!;
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    const val = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${f} needs a value`);
      return v;
    };
    if (!f.startsWith('--')) a.positional.push(f);
    else if (f === '--since') a.since = parseDate(val());
    else if (f === '--until') a.until = parseDate(val()) + 86_400_000;
    else if (f === '--days') days = Number(val());
    else if (f === '--by') a.by = val() as Args['by'];
    else if (f === '--json') a.json = true;
    else if (f === '--no-cache') a.noCache = true;
    else if (f === '--local-only') a.localOnly = true;
    else if (['--billing', '--plan', '--fee', '--currency', '--rate'].includes(f)) a.opts[f.slice(2)] = val();
    else throw new Error(`unknown option: ${f}`);
  }
  if (!a.since) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    a.since = d.getTime() - (days - 1) * 86_400_000;
  }
  return a;
}

type Totals = Omit<Usage, 'fast' | 'geoUS'> & { total: number; usd: number };
const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, total: 0, usd: 0 });

function add(t: Totals, u: Usage, usd: number, w: number) {
  t.input += u.input * w;
  t.output += u.output * w;
  t.cacheRead += u.cacheRead * w;
  t.cacheWrite += u.cacheWrite * w;
  t.cacheWrite5m += u.cacheWrite5m * w;
  t.cacheWrite1h += u.cacheWrite1h * w;
  t.webSearch += u.webSearch * w;
  t.total += (u.input + u.output + u.cacheRead + u.cacheWrite) * w;
  t.usd += usd * w;
}

const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const localTime = (ts: number) => {
  const d = new Date(ts);
  return `${localDay(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function group(items: Attributed[], by: Args['by'], prices: PriceTable): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const it of items) {
    const usd = costOf(prices, it.rec.model, it.rec.usage) ?? 0;
    const keys: [string, number][] =
      by === 'repo'
        ? it.shares.map((s) => [s.repo, s.weight])
        : [[by === 'day' ? localDay(it.rec.ts) : it.rec.model, 1]];
    for (const [k, w] of keys) {
      let t = out.get(k);
      if (!t) out.set(k, (t = zero()));
      add(t, it.rec.usage, usd, w);
    }
  }
  return out;
}

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`;

function money(usd: number, cfg: Config): string {
  const base = `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`;
  if (!cfg.currency || !cfg.ratePerUsd) return base;
  return `${base} (${Math.round(usd * cfg.ratePerUsd).toLocaleString()} ${cfg.currency})`;
}

// Terminal column width: CJK and Hangul take two cells.
const width = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const pad = (s: string, w: number, left: boolean) => (left ? s + ' '.repeat(w - width(s)) : ' '.repeat(w - width(s)) + s);

function table(rows: string[][]) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => width(r[i]))));
  return rows.map((r) => r.map((c, i) => pad(c, w[i], i === 0)).join('  ')).join('\n');
}

async function loadAll(args: Args) {
  const roots = defaultLogRoots();
  if (!roots.length) throw new Error('No Claude Code logs found (looked in ~/.claude/projects and ~/.config/claude/projects).');
  const files = listLogFiles(roots);
  const tty = process.stderr.isTTY;
  const res = await loadRecords(files, {
    noCache: args.noCache,
    onProgress: tty ? (d, t) => d % 25 === 0 && process.stderr.write(`\rreading logs ${d}/${t}`) : undefined,
  });
  if (tty) process.stderr.write('\r\x1b[K');
  return { roots, res };
}

function unpricedModels(records: UsageRecord[], prices: PriceTable): string[] {
  return [...new Set(records.filter((r) => costOf(prices, r.model, r.usage) === null).map((r) => normalizeModel(r.model)))];
}

function cmdDoctor(roots: string[], res: Awaited<ReturnType<typeof loadRecords>>, inRange: UsageRecord[], prices: PriceTable) {
  const items = attribute(inRange);
  const levels: Record<Level, number> = { direct: 0, turn: 0, agent: 0, session: 0, cwd: 0, none: 0 };
  const levelTokens = { ...levels };
  for (const it of items) {
    levels[it.level]++;
    levelTokens[it.level] += it.rec.usage.input + it.rec.usage.output + it.rec.usage.cacheRead + it.rec.usage.cacheWrite;
  }
  const count = (key: (r: UsageRecord) => string) => {
    const m = new Map<string, number>();
    for (const r of inRange) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 8));
  };
  const allTok = Object.values(levelTokens).reduce((a, b) => a + b, 0) || 1;
  console.log(
    JSON.stringify(
      {
        logRoots: roots,
        files: res.files,
        reparsed: res.reparsed,
        lines: res.lines,
        unreadableLines: res.badJson,
        assistantLinesWithoutUsage: res.noUsage,
        responses: res.records.length,
        duplicatesAcrossFiles: res.duplicatesAcrossFiles,
        inRange: inRange.length,
        attribution: Object.fromEntries(
          (Object.keys(levels) as Level[]).map((l) => [l, { responses: levels[l], tokenShare: `${((levelTokens[l] / allTok) * 100).toFixed(1)}%` }]),
        ),
        entrypoints: count((r) => r.entrypoint ?? '(imported)'),
        claudeCodeVersions: count((r) => r.version ?? '?'),
        prices: { source: prices.source, checked: prices.checked, unpricedModels: unpricedModels(inRange, prices) },
        calibrationSamples: readSamples().length,
      },
      null,
      2,
    ),
  );
}

function cmdUsage(args: Args, inRange: UsageRecord[], prices: PriceTable, cfg: Config) {
  const g = [...group(attribute(inRange), args.by, prices)].sort((a, b) => (args.by === 'day' ? a[0].localeCompare(b[0]) : b[1].usd - a[1].usd));
  if (args.json) {
    const round = (t: Totals) => Object.fromEntries(Object.entries(t).map(([f, v]) => [f, f === 'usd' ? Math.round(v * 100) / 100 : Math.round(v)]));
    console.log(JSON.stringify(Object.fromEntries(g.map(([k, t]) => [k, round(t)])), null, 2));
    return;
  }
  const grandTok = g.reduce((s, [, t]) => s + t.total, 0) || 1;
  const grandUsd = g.reduce((s, [, t]) => s + t.usd, 0);
  const label = (k: string) => (args.by === 'repo' && k !== UNATTRIBUTED ? path.basename(k) : k);
  const rows = [[args.by, 'input', 'output', 'cache write', 'cache read', 'total', 'tok %', 'API $']];
  for (const [k, t] of g)
    rows.push([label(k), fmt(t.input), fmt(t.output), fmt(t.cacheWrite), fmt(t.cacheRead), fmt(t.total), ((t.total / grandTok) * 100).toFixed(1), `$${t.usd.toFixed(2)}`]);
  console.log(`${localDay(args.since)} .. ${args.until === Infinity ? 'now' : localDay(args.until - 1)}  (${inRange.length} responses)\n`);
  console.log(table(rows));
  console.log(`\nAPI-equivalent total: ${money(grandUsd, cfg)}`);
  if (cfg.billing === 'subscription' && cfg.monthlyFeeUsd) {
    const days = (Math.min(Date.now(), args.until) - args.since) / 86_400_000;
    const fee = (cfg.monthlyFeeUsd * days) / 30;
    console.log(`Subscription fee for this period: ~${money(fee, cfg)} → you used ${(grandUsd / fee).toFixed(1)}× its API value`);
  }
  const missing = unpricedModels(inRange, prices);
  if (missing.length) console.log(`No price for: ${missing.join(', ')} (excluded from $; add them in ~/.scopeburn/prices.override.json)`);
  console.log(`Prices: ${prices.source} (checked ${prices.checked})`);
  if (!cfg.billing) console.log('Tip: tell scopeburn how you pay — `scopeburn config --billing subscription --plan max5 --fee 100` or `--billing api`.');
}

function describeWindow(name: string, w: WindowStatus | null, cfg: Config, now: number) {
  if (!w) {
    console.log(`${name}: no active window${name === 'Weekly' ? ' (needs a status line sample to know the reset time)' : ''}`);
    return;
  }
  const left = Math.max(0, w.end - now);
  const mins = Math.round(left / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  console.log(`${name} window ${localTime(w.start)} → ${localTime(w.end)}${w.exact ? '' : ' (rebuilt from activity, approximate)'}`);
  console.log(`  resets in ${h}h ${m}m`);
  console.log(`  spent here (this machine, API-equivalent): ${money(w.spent, cfg)}`);
  if (w.reportedPct != null) console.log(`  Claude Code reports ${w.reportedPct.toFixed(0)}% used (as of ${localTime(w.reportedAt!)})`);
  if (w.cap) {
    const c = w.cap;
    console.log(`  estimated cap ≈ ${money(c.median, cfg)} (range ${money(c.min, cfg)}–${money(c.max, cfg)}, ${c.samples} samples)`);
    if (c.samples >= 3 && c.max > c.min * 1.5) console.log('  wide range: usage outside this machine (web app, other PCs) may be mixed in');
  } else console.log('  cap: needs calibration (install the status line, or run `scopeburn calibrate <5h%> [7d%]`)');
  console.log(`  burn rate (last 45 min): ${money(w.burnPerHour, cfg)}/h`);
  if (w.hitsCapAt) console.log(`  at this rate you hit the cap around ${localTime(w.hitsCapAt)}`);
  else if (w.cap && w.burnPerHour > 0) console.log('  at this rate you stay under the cap until the reset');
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** One-line item label: markdown emphasis/code stripped, long titles cut. */
function itemLabel(key: string, title: string): string {
  const t = title.replace(/\*+|`+/g, '').replace(/\s+/g, ' ').trim();
  const short = t.length > 60 ? `${t.slice(0, 57)}…` : t;
  return key.startsWith('~') ? short : `{${key}} ${short}`;
}

function cmdRoadmap(args: Args, records: UsageRecord[]) {
  // Projects: the paths given, else every project seen in the logs (plus cwd) that has a ROADMAP.md.
  let roots: string[];
  if (args.positional.length) roots = args.positional.map((p) => path.resolve(p));
  else {
    const seen = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r.repos)) seen.add(k);
      if (r.cwdRepo) seen.add(r.cwdRepo);
    }
    const here = repoRootOfPath(process.cwd());
    if (here) seen.add(here);
    roots = [...seen].filter((r) => existsSync(path.join(r, ROADMAP_FILE))).sort();
  }
  if (!roots.length) {
    console.log(`No ${ROADMAP_FILE} found. Create one in a project (see docs), or pass a path: scopeburn roadmap <repo>`);
    return;
  }
  // Last activity per project, from the usage logs.
  const lastActive = new Map<string, number>();
  for (const it of attribute(records)) for (const s of it.shares) lastActive.set(s.repo, Math.max(lastActive.get(s.repo) ?? 0, it.rec.ts));

  const out: Record<string, unknown> = {};
  for (const root of roots) {
    const snaps = snapshots(root);
    const sum = summarize(snaps);
    if (!sum) {
      console.log(`${path.basename(root)}: no ${ROADMAP_FILE}`);
      continue;
    }
    const pts = burnup(snaps);
    const last = lastActive.get(root) ?? null;
    if (args.json) {
      out[root] = { summary: sum, burnup: pts, lastActivity: last };
      continue;
    }
    const n = sum.now;
    const pct = n.scope ? Math.round((n.done / n.scope) * 100) : 0;
    console.log(`${path.basename(root)}  (stage: ${sum.stage ?? 'unset'}, ${snaps.length} snapshots)`);
    console.log(`  scope ${n.scope} pts · done ${n.done} (${pct}%) · cut ${n.cut} · ${n.openItems} open items`);
    if (sum.growthRatio != null)
      console.log(`  last 14 days: scope +${sum.scopeAdded14d}, done +${sum.done14d} → growth ${sum.growthRatio.toFixed(2)}${sum.growthRatio > 1 ? '  ⚠ scope is growing faster than work gets done' : ''}`);
    else if (sum.scopeAdded14d > 0) console.log(`  last 14 days: scope +${sum.scopeAdded14d}, nothing finished`);
    if (sum.medianLeadDays != null) console.log(`  median decided → done: ${days(sum.medianLeadDays)}`);
    const idle = last ? Math.floor((Date.now() - last) / 86_400_000) : null;
    for (const t of sum.inProgress)
      console.log(`  in progress: ${itemLabel(t.item.key, t.item.title)} — since ${t.start}${idle != null && idle >= 7 ? `, no Claude activity in this project for ${days(idle)}` : ''}`);
    for (const t of sum.waiting.slice(0, 5)) console.log(`  waiting: ${itemLabel(t.item.key, t.item.title)} — decided ${t.ageDays ? `${days(t.ageDays)} ago` : 'today'}`);
    if (sum.waiting.length > 5) console.log(`  … ${sum.waiting.length - 5} more waiting`);
    const noId = sum.warnings.filter((w) => w.includes('no {ID}')).length;
    if (noId) console.log(`  note: ${noId} items have no {ID}; their history is tracked by title, so renaming one breaks its timeline`);
    for (const w of sum.warnings.filter((w) => !w.includes('no {ID}')).slice(0, 3)) console.log(`  note: ${w}`);
    const tail = pts.slice(-8);
    console.log(`  burn-up: ${tail.map((p) => `${p.date.slice(5)} ${p.done}/${p.scope}`).join('  ')}`);
    console.log('');
  }
  if (args.json) console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === 'statusline') {
    const sub = args.positional[0];
    if (sub === 'install') return console.log(`scopeburn status line ${installStatusline()}`);
    if (sub === 'uninstall') return console.log(uninstallStatusline());
    return statuslineMain();
  }

  const cfg = loadConfig();
  if (args.cmd === 'config') {
    const o = args.opts;
    if (o.billing) {
      if (o.billing !== 'subscription' && o.billing !== 'api') throw new Error('--billing must be subscription or api');
      cfg.billing = o.billing;
    }
    if (o.plan) cfg.plan = o.plan;
    if (o.fee) cfg.monthlyFeeUsd = Number(o.fee);
    if (o.currency) cfg.currency = o.currency;
    if (o.rate) cfg.ratePerUsd = Number(o.rate);
    if (Object.keys(o).length) saveConfig(cfg);
    return console.log(JSON.stringify(cfg, null, 2));
  }

  if (args.cmd === 'calibrate') {
    const [five, week] = args.positional.map(Number);
    if (!Number.isFinite(five)) throw new Error('usage: scopeburn calibrate <5h%> [7d%]');
    // Manual samples carry no reset time; they need one to be paired with a window, see limits.ts.
    appendSample({ ts: Date.now(), session: null, five: { pct: five, resetsAt: null }, week: Number.isFinite(week) ? { pct: week, resetsAt: null } : null, source: 'manual' });
    return console.log('calibration sample recorded');
  }

  const prices = loadPrices();
  const { roots, res } = await loadAll(args);
  const inRange = res.records.filter((r) => r.ts >= args.since && r.ts < args.until && (!args.localOnly || r.entrypoint));

  if (args.cmd === 'doctor') return cmdDoctor(roots, res, inRange, prices);
  if (args.cmd === 'usage') return cmdUsage(args, inRange, prices, cfg);
  if (args.cmd === 'roadmap') return cmdRoadmap(args, res.records);
  if (args.cmd === 'limits') {
    // Limits are per account, so imported sessions count unless --local-only.
    const all = args.localOnly ? res.records.filter((r) => r.entrypoint) : res.records;
    const ix = buildCostIndex(all, prices);
    const samples = resolveSamples(ix, readSamples());
    const now = Date.now();
    const five = windowStatus(ix, samples, 'five', now);
    const week = windowStatus(ix, samples, 'week', now);
    if (args.json) return console.log(JSON.stringify({ five, week, samples: samples.length }, null, 2));
    describeWindow('5-hour', five, cfg, now);
    console.log('');
    describeWindow('Weekly', week, cfg, now);
    if (!samples.length) console.log('\nNo calibration samples yet. `scopeburn statusline install` records them automatically (Pro/Max).');
    return;
  }
  throw new Error(`unknown command: ${args.cmd}`);
}

main().catch((e) => {
  console.error(`scopeburn: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
