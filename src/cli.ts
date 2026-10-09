import * as path from 'node:path';
import { attribute, UNATTRIBUTED, type Attributed, type Level } from './attribute.ts';
import { loadRecords } from './cache.ts';
import { defaultLogRoots, listLogFiles, type Usage } from './logs.ts';

interface Args {
  cmd: string;
  since: number;
  until: number;
  by: 'repo' | 'day' | 'model';
  json: boolean;
  noCache: boolean;
  /** drop sessions with no entrypoint (run elsewhere, imported into this machine's logs) */
  localOnly: boolean;
}

function parseDate(s: string): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date: ${s} (use YYYY-MM-DD)`);
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime(); // local midnight
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: 'usage', since: 0, until: Infinity, by: 'repo', json: false, noCache: false, localOnly: false };
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
    if (f === '--since') a.since = parseDate(val());
    else if (f === '--until') a.until = parseDate(val()) + 86_400_000;
    else if (f === '--days') days = Number(val());
    else if (f === '--by') a.by = val() as Args['by'];
    else if (f === '--json') a.json = true;
    else if (f === '--no-cache') a.noCache = true;
    else if (f === '--local-only') a.localOnly = true;
    else throw new Error(`unknown option: ${f}`);
  }
  if (!a.since) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    a.since = d.getTime() - (days - 1) * 86_400_000;
  }
  return a;
}

type Totals = Usage & { total: number };
const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, total: 0 });

function add(t: Totals, u: Usage, w: number) {
  t.input += u.input * w;
  t.output += u.output * w;
  t.cacheRead += u.cacheRead * w;
  t.cacheWrite += u.cacheWrite * w;
  t.cacheWrite5m += u.cacheWrite5m * w;
  t.cacheWrite1h += u.cacheWrite1h * w;
  t.webSearch += u.webSearch * w;
  t.total += (u.input + u.output + u.cacheRead + u.cacheWrite) * w;
}

const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function group(items: Attributed[], by: Args['by']): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const it of items) {
    const keys: [string, number][] =
      by === 'repo'
        ? it.shares.map((s) => [s.repo, s.weight])
        : [[by === 'day' ? localDay(it.rec.ts) : it.rec.model, 1]];
    for (const [k, w] of keys) {
      let t = out.get(k);
      if (!t) out.set(k, (t = zero()));
      add(t, it.rec.usage, w);
    }
  }
  return out;
}

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`;

function table(rows: string[][]) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')).join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = defaultLogRoots();
  if (!roots.length) throw new Error('No Claude Code logs found (looked in ~/.claude/projects and ~/.config/claude/projects).');
  const files = listLogFiles(roots);
  const tty = process.stderr.isTTY;
  const res = await loadRecords(files, {
    noCache: args.noCache,
    onProgress: tty ? (d, t) => d % 25 === 0 && process.stderr.write(`\rreading logs ${d}/${t}`) : undefined,
  });
  if (tty) process.stderr.write('\r\x1b[K');

  const inRange = res.records.filter((r) => r.ts >= args.since && r.ts < args.until && (!args.localOnly || r.entrypoint));
  const items = attribute(inRange);

  if (args.cmd === 'doctor') {
    const levels: Record<Level, number> = { direct: 0, turn: 0, agent: 0, session: 0, cwd: 0, none: 0 };
    const levelTokens = { ...levels };
    for (const it of items) {
      levels[it.level]++;
      levelTokens[it.level] += it.rec.usage.input + it.rec.usage.output + it.rec.usage.cacheRead + it.rec.usage.cacheWrite;
    }
    const versions = new Map<string, number>();
    for (const r of inRange) versions.set(r.version ?? '?', (versions.get(r.version ?? '?') ?? 0) + 1);
    const entrypoints = new Map<string, number>();
    for (const r of inRange) entrypoints.set(r.entrypoint ?? '(imported)', (entrypoints.get(r.entrypoint ?? '(imported)') ?? 0) + 1);
    const allTok = Object.values(levelTokens).reduce((a, b) => a + b, 0) || 1;
    const out = {
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
      entrypoints: Object.fromEntries(entrypoints),
      claudeCodeVersions: Object.fromEntries([...versions].sort((a, b) => b[1] - a[1]).slice(0, 8)),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (args.cmd !== 'usage') throw new Error(`unknown command: ${args.cmd}`);
  const g = [...group(items, args.by)].sort((a, b) => (args.by === 'day' ? a[0].localeCompare(b[0]) : b[1].total - a[1].total));

  if (args.json) {
    console.log(JSON.stringify(Object.fromEntries(g.map(([k, t]) => [k, Object.fromEntries(Object.entries(t).map(([f, v]) => [f, Math.round(v)]))])), null, 2));
    return;
  }
  const grand = g.reduce((s, [, t]) => s + t.total, 0) || 1;
  const label = (k: string) => (args.by === 'repo' && k !== UNATTRIBUTED ? path.basename(k) : k);
  const rows = [[args.by, 'input', 'output', 'cache write', 'cache read', 'total', '%']];
  for (const [k, t] of g) rows.push([label(k), fmt(t.input), fmt(t.output), fmt(t.cacheWrite), fmt(t.cacheRead), fmt(t.total), `${((t.total / grand) * 100).toFixed(1)}`]);
  console.log(`${localDay(args.since)} .. ${args.until === Infinity ? 'now' : localDay(args.until - 1)}  (${inRange.length} responses)\n`);
  console.log(table(rows));
}

main().catch((e) => {
  console.error(`scopeburn: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
