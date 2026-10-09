// Claude Code status line hook. Claude Code pipes a JSON payload to the status line command;
// for Pro/Max accounts it includes rate_limits.five_hour / seven_day (used_percentage, resets_at).
// We record those as calibration samples, then print either the wrapped command's output or a short line.
// This runs on every status line refresh, so it must stay cheap: no log parsing here.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dataDir } from './cache.ts';
import { loadConfig, saveConfig } from './config.ts';

export interface Window {
  pct: number;
  /** epoch ms */
  resetsAt: number | null;
}

export interface Sample {
  ts: number;
  session: string | null;
  five: Window | null;
  week: Window | null;
  source: 'statusline' | 'manual';
}

export const samplesFile = () => path.join(dataDir(), 'calibration.jsonl');
const stateFile = () => path.join(dataDir(), 'statusline-state.json');
const MIN_INTERVAL_MS = 60_000;

/** resets_at arrives as epoch seconds in most builds and as an ISO string in some. */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return toEpochMs(n);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function readWindow(w: any): Window | null {
  if (!w || typeof w.used_percentage !== 'number') return null;
  return { pct: w.used_percentage, resetsAt: toEpochMs(w.resets_at) };
}

export function sampleFromPayload(p: any, now = Date.now()): Sample | null {
  const five = readWindow(p?.rate_limits?.five_hour);
  const week = readWindow(p?.rate_limits?.seven_day);
  if (!five && !week) return null;
  return { ts: now, session: typeof p?.session_id === 'string' ? p.session_id : null, five, week, source: 'statusline' };
}

export function appendSample(s: Sample) {
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(samplesFile(), `${JSON.stringify(s)}\n`);
}

export function readSamples(): Sample[] {
  if (!existsSync(samplesFile())) return [];
  const out: Sample[] = [];
  for (const line of readFileSync(samplesFile(), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Record a sample when the numbers changed, at most once a minute unless a new 5h window started. */
function maybeRecord(s: Sample) {
  let last: { ts: number; key: string; resets: number | null } | null = null;
  try {
    last = JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {}
  const key = JSON.stringify([s.five?.pct, s.five?.resetsAt, s.week?.pct, s.week?.resetsAt]);
  const resets = s.five?.resetsAt ?? null;
  if (last?.key === key) return;
  if (last && last.resets === resets && s.ts - last.ts < MIN_INTERVAL_MS) return;
  appendSample(s);
  writeFileSync(stateFile(), JSON.stringify({ ts: s.ts, key, resets }));
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function runWrapped(cmd: string, input: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
    child.stdin.end(input);
  });
}

export async function statuslineMain() {
  const raw = await readStdin();
  let payload: any = null;
  try {
    payload = JSON.parse(raw);
  } catch {}
  try {
    const s = payload && sampleFromPayload(payload);
    if (s) maybeRecord(s);
  } catch {} // the status line must never break because of us

  const wrapped = loadConfig().statuslineWrapped;
  if (wrapped) {
    process.stdout.write(await runWrapped(wrapped, raw));
    return;
  }
  const parts: string[] = [];
  if (payload?.model?.display_name) parts.push(payload.model.display_name);
  const five = readWindow(payload?.rate_limits?.five_hour);
  const week = readWindow(payload?.rate_limits?.seven_day);
  if (five) parts.push(`5h ${Math.round(five.pct)}%`);
  if (week) parts.push(`7d ${Math.round(week.pct)}%`);
  process.stdout.write(parts.join(' · '));
}

// ---- install / uninstall into Claude Code settings ----

function settingsPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.split(path.delimiter).find(Boolean) ?? path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

const backupFile = () => path.join(dataDir(), 'statusline-backup.json');

export function writeJsonPreservingIndent(file: string, original: string, obj: unknown) {
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? '  ';
  const tmp = `${file}.scopeburn.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, indent)}\n`);
  renameSync(tmp, file);
}

export function ourCommand(): string {
  return `node "${path.resolve(process.argv[1])}" statusline`;
}

export function installStatusline(): string {
  const file = settingsPath();
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
  const settings = JSON.parse(original);
  const prev = settings.statusLine;
  const cmd = ourCommand();
  if (prev?.command === cmd) return `already installed in ${file}`;
  if (prev?.command && /scopeburn/.test(prev.command)) {
    settings.statusLine = { ...prev, command: cmd }; // path moved; keep the existing backup
  } else {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(backupFile(), JSON.stringify({ file, statusLine: prev ?? null }, null, 2));
    const cfg = loadConfig();
    cfg.statuslineWrapped = prev?.type === 'command' && prev.command ? prev.command : null;
    saveConfig(cfg);
    settings.statusLine = { ...(prev ?? {}), type: 'command', command: cmd };
  }
  writeJsonPreservingIndent(file, original, settings);
  const cfg = loadConfig();
  return `installed in ${file}${cfg.statuslineWrapped ? ` (wrapping your existing command: ${cfg.statuslineWrapped})` : ''}`;
}

export function uninstallStatusline(): string {
  const file = settingsPath();
  if (!existsSync(file)) return 'no Claude Code settings file found';
  const original = readFileSync(file, 'utf8');
  const settings = JSON.parse(original);
  if (!settings.statusLine?.command || !/scopeburn/.test(settings.statusLine.command)) return 'scopeburn status line is not installed';
  let prev: unknown = null;
  try {
    prev = JSON.parse(readFileSync(backupFile(), 'utf8')).statusLine;
  } catch {}
  if (prev) settings.statusLine = prev;
  else delete settings.statusLine;
  writeJsonPreservingIndent(file, original, settings);
  const cfg = loadConfig();
  cfg.statuslineWrapped = null;
  saveConfig(cfg);
  return `removed from ${file}${prev ? ' (previous status line restored)' : ''}`;
}
