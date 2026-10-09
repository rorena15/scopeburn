// Reads Claude Code session logs (~/.claude/projects/**/*.jsonl) into usage records.
// Only usage numbers, ids, timestamps and path-like tool inputs are read; message text is never kept.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { pathsFromToolInput, toNative } from './paths.ts';
import { projectRootOf } from './repo.ts';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  /** cache_creation_input_tokens (total, whatever the TTL) */
  cacheWrite: number;
  /** split by TTL when the log has it; both 0 when it doesn't */
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  /** fast mode (premium-priced) response */
  fast: boolean;
  /** US-only inference (inference_geo: "us"), priced with a multiplier */
  geoUS: boolean;
}

export interface UsageRecord {
  /** message.id + requestId; the dedupe key */
  key: string;
  ts: number;
  model: string;
  session: string;
  agent: string | null;
  /** user prompt this response belongs to, unique across files */
  turn: string;
  /** repo root -> number of path references in this response */
  repos: Record<string, number>;
  cwdRepo: string | null;
  version: string | null;
  /** Claude Code client that wrote the line (cli, claude-vscode, ...); null for sessions imported from elsewhere */
  entrypoint: string | null;
  usage: Usage;
}

export interface FileParse {
  records: UsageRecord[];
  lines: number;
  badJson: number;
  /** assistant lines without a readable usage block */
  noUsage: number;
}

export function defaultLogRoots(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const bases = env
    ? env.split(path.delimiter).filter(Boolean)
    : [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.config', 'claude')];
  return bases.map((b) => path.join(b, 'projects')).filter((p) => existsSync(p));
}

export function listLogFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'memory' && e.name !== 'tool-results') walk(p);
      } else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  roots.forEach(walk);
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readUsage(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null;
  if (typeof u.input_tokens !== 'number' && typeof u.output_tokens !== 'number') return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    cacheWrite5m: num(u.cache_creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
    webSearch: num(u.server_tool_use?.web_search_requests),
    fast: u.speed === 'fast',
    geoUS: u.inference_geo === 'us',
  };
}

/** A user line that starts a new turn: a real prompt, not a tool result or meta line. */
function isPrompt(d: any): boolean {
  if (d.type !== 'user' || d.isMeta) return false;
  const c = d.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b: any) => b?.type === 'text');
}

function addRepos(target: Record<string, number>, rawPaths: string[], cwd: string | undefined) {
  for (const raw of rawPaths) {
    const p = toNative(raw, cwd);
    if (!p) continue;
    const root = projectRootOf(p);
    if (root) target[root] = (target[root] ?? 0) + 1;
  }
}

export async function parseFile(file: string): Promise<FileParse> {
  const byKey = new Map<string, UsageRecord>();
  let lines = 0;
  let badJson = 0;
  let noUsage = 0;
  let turnNo = 0;
  const fileId = path.basename(file, '.jsonl');

  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      badJson++;
      continue;
    }
    if (isPrompt(d)) {
      turnNo++;
      continue;
    }
    if (d.type !== 'assistant') continue;
    const msg = d.message;
    const usage = readUsage(msg?.usage);
    if (!usage || !msg?.id) {
      noUsage++;
      continue;
    }
    const model = typeof msg.model === 'string' ? msg.model : 'unknown';
    if (model === '<synthetic>') continue; // locally generated, never billed

    const key = `${msg.id}:${d.requestId ?? ''}`;
    let rec = byKey.get(key);
    if (!rec) {
      const cwd = typeof d.cwd === 'string' ? d.cwd : undefined;
      const cwdPath = cwd ? toNative(cwd) : null;
      rec = {
        key,
        ts: Date.parse(d.timestamp) || 0,
        model,
        session: d.sessionId ?? fileId,
        agent: d.agentId ?? null,
        turn: `${fileId}#${turnNo}`,
        repos: {},
        cwdRepo: cwdPath ? projectRootOf(cwdPath) : null,
        version: d.version ?? null,
        entrypoint: d.entrypoint ?? null,
        usage,
      };
      byKey.set(key, rec);
    } else {
      rec.usage = usage; // the same response is logged once per content block; keep the last usage
    }
    // Each duplicate line carries a different content block, so paths are collected from all of them.
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (b?.type === 'tool_use') addRepos(rec.repos, pathsFromToolInput(b.input), d.cwd);
    }
  }
  return { records: [...byKey.values()], lines, badJson, noUsage };
}

export function fileStamp(file: string): { size: number; mtimeMs: number } {
  const s = statSync(file);
  return { size: s.size, mtimeMs: s.mtimeMs };
}
