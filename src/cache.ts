// Incremental parse cache: a file is re-read only when its size or mtime changed.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileStamp, parseFile, type FileParse, type UsageRecord } from './logs.ts';

// Bump whenever parsing or attribution rules change, so stale cached records are re-read.
const CACHE_VERSION = 5;

interface CacheEntry extends FileParse {
  size: number;
  mtimeMs: number;
}

interface CacheFile {
  version: number;
  files: Record<string, CacheEntry>;
}

export function dataDir(): string {
  return process.env.SCOPEBURN_HOME ?? path.join(os.homedir(), '.scopeburn');
}

function cachePath() {
  return path.join(dataDir(), 'cache', `usage-v${CACHE_VERSION}.json`);
}

function load(): CacheFile {
  try {
    const c = JSON.parse(readFileSync(cachePath(), 'utf8')) as CacheFile;
    if (c.version === CACHE_VERSION) return c;
  } catch {}
  return { version: CACHE_VERSION, files: {} };
}

function save(c: CacheFile) {
  const p = cachePath();
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, p);
}

export interface LoadResult {
  records: UsageRecord[];
  files: number;
  reparsed: number;
  lines: number;
  badJson: number;
  noUsage: number;
  duplicatesAcrossFiles: number;
}

export async function loadRecords(
  files: string[],
  opts: { noCache?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<LoadResult> {
  const cache = opts.noCache ? { version: CACHE_VERSION, files: {} } : load();
  const next: CacheFile = { version: CACHE_VERSION, files: {} };
  let reparsed = 0;
  let done = 0;
  for (const f of files) {
    const st = fileStamp(f);
    let e = cache.files[f];
    if (!e || e.size !== st.size || e.mtimeMs !== st.mtimeMs) {
      e = { ...(await parseFile(f)), ...st };
      reparsed++;
    }
    next.files[f] = e;
    opts.onProgress?.(++done, files.length);
  }
  if (!opts.noCache && (reparsed > 0 || Object.keys(cache.files).length !== files.length)) save(next);

  // Resumed sessions copy earlier history into a new file, so dedupe globally.
  const merged = new Map<string, UsageRecord>();
  let dup = 0;
  let lines = 0;
  let badJson = 0;
  let noUsage = 0;
  for (const e of Object.values(next.files)) {
    lines += e.lines;
    badJson += e.badJson;
    noUsage += e.noUsage;
    for (const r of e.records) {
      const prev = merged.get(r.key);
      if (!prev) {
        merged.set(r.key, r);
        continue;
      }
      dup++;
      for (const [repo, n] of Object.entries(r.repos)) prev.repos[repo] = Math.max(prev.repos[repo] ?? 0, n);
    }
  }
  return { records: [...merged.values()], files: files.length, reparsed, lines, badJson, noUsage, duplicatesAcrossFiles: dup };
}

