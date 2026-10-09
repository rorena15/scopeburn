// Local record of when scopeburn itself is used, so "is this worth keeping?" has an answer.
// One line per run: date and command. Never leaves the machine.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { dataDir } from './cache.ts';

const file = () => path.join(dataDir(), 'runs.jsonl');

export function recordRun(cmd: string) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(file(), `${JSON.stringify({ ts: Date.now(), cmd })}\n`);
  } catch {}
}

export interface SelfUse {
  runs: number;
  /** distinct local days with at least one run, per week (most recent first) */
  daysPerWeek: { weekStarting: string; days: number; runs: number }[];
  byCommand: Record<string, number>;
}

const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function selfUse(weeks = 4, now = Date.now()): SelfUse {
  const runs: { ts: number; cmd: string }[] = [];
  if (existsSync(file())) {
    for (const line of readFileSync(file(), 'utf8').split('\n')) {
      try {
        if (line) runs.push(JSON.parse(line));
      } catch {}
    }
  }
  const out: SelfUse = { runs: 0, daysPerWeek: [], byCommand: {} };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (let w = 0; w < weeks; w++) {
    const to = start.getTime() + 86_400_000 - w * 7 * 86_400_000;
    const from = to - 7 * 86_400_000;
    const inWeek = runs.filter((r) => r.ts >= from && r.ts < to);
    out.daysPerWeek.push({ weekStarting: localDay(from), days: new Set(inWeek.map((r) => localDay(r.ts))).size, runs: inWeek.length });
  }
  const horizon = start.getTime() + 86_400_000 - weeks * 7 * 86_400_000;
  for (const r of runs) {
    if (r.ts < horizon) continue;
    out.runs++;
    out.byCommand[r.cmd] = (out.byCommand[r.cmd] ?? 0) + 1;
  }
  return out;
}
