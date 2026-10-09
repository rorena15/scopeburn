// Path normalization across Windows, Git Bash, WSL and POSIX spellings,
// plus extraction of file paths from Claude Code tool_use inputs.
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

const IS_WIN = process.platform === 'win32';
const IS_WSL = !IS_WIN && existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');

/** Convert any spelling of a path into a native absolute path, or null if it can't be resolved. */
export function toNative(raw: string, cwd?: string): string | null {
  let s = raw.trim().replace(/^["']+|["']+$/g, '');
  if (!s) return null;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = os.homedir() + s.slice(1);

  if (IS_WIN) {
    const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s) ?? /^\/([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:${m[2] ?? '/'}`;
  } else {
    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(s);
    if (m) {
      if (!IS_WSL) return null; // a Windows path seen from macOS/Linux can't be resolved
      s = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
    }
  }

  if (!path.isAbsolute(s)) {
    if (!cwd) return null;
    const base = toNative(cwd);
    if (!base) return null;
    s = path.resolve(base, s);
  }
  return path.normalize(s);
}

/** Comparison key: case-insensitive on Windows/macOS default filesystems. */
export function pathKey(p: string): string {
  return IS_WIN || process.platform === 'darwin' ? p.toLowerCase() : p;
}

const PATH_FIELDS = new Set(['file_path', 'path', 'notebook_path']);
const COMMAND_FIELDS = new Set(['command']);

// Absolute paths inside a shell command: quoted first (may hold spaces), then bare.
const QUOTED = /["']((?:[A-Za-z]:[\\/]|\/(?:mnt\/)?[a-zA-Z]\/|~[\\/]|\/(?:Users|home)\/)[^"']*)["']/g;
const BARE = /(?:^|[\s=(])((?:[A-Za-z]:[\\/]|\/(?:mnt\/)?[a-zA-Z]\/|~[\\/]|\/(?:Users|home)\/)[^\s"'`|;&<>()]*)/g;

export function pathsFromCommand(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(QUOTED)) out.push(m[1]);
  const unquoted = cmd.replace(QUOTED, ' ');
  for (const m of unquoted.matchAll(BARE)) out.push(m[1]);
  return out;
}

/** Raw path strings referenced by a tool_use input object. Only path-like fields are read. */
export function pathsFromToolInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (PATH_FIELDS.has(k)) out.push(v);
    else if (COMMAND_FIELDS.has(k)) out.push(...pathsFromCommand(v));
  }
  return out;
}
