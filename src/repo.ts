// Maps a path to the project that owns it.
// A project is the nearest git repository root, or, for folders that aren't git repos,
// an existing child folder of a "workspace" (a folder that holds two or more git repos side by side).
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { pathKey } from './paths.ts';

const repoCache = new Map<string, string | null>();
const workspaceCache = new Map<string, boolean>();

// Children of a workspace that are never projects (config, OS and tool folders).
const NOT_PROJECTS = new Set(['appdata', 'library', 'application data', 'node_modules']);

export function repoRootOf(p: string): string | null {
  const visited: string[] = [];
  let dir = p;
  let found: string | null = null;
  for (;;) {
    const k = pathKey(dir);
    const hit = repoCache.get(k);
    if (hit !== undefined) {
      found = hit;
      break;
    }
    visited.push(k);
    if (existsSync(path.join(dir, '.git'))) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const k of visited) repoCache.set(k, found);
  return found;
}

function isWorkspace(dir: string): boolean {
  const k = pathKey(dir);
  const hit = workspaceCache.get(k);
  if (hit !== undefined) return hit;
  let repos = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(path.join(dir, e.name, '.git')) && ++repos >= 2) break;
    }
  } catch {}
  workspaceCache.set(k, repos >= 2);
  return repos >= 2;
}

/** The workspace child folder containing `p`, when `p` lies under a workspace. Works for deleted paths too. */
function workspaceChildOf(p: string): string | null {
  let child = p;
  let dir = path.dirname(p);
  while (dir !== child) {
    if (existsSync(dir) && isWorkspace(dir)) {
      const name = path.basename(child);
      if (name.startsWith('.') || NOT_PROJECTS.has(name.toLowerCase())) return null;
      return isDir(child) ? child : null; // loose files at the workspace top level aren't projects
    }
    child = dir;
    dir = path.dirname(dir);
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const canonical = new Map<string, string>();

/** One spelling per folder (true on-disk case), so `E:\x` and `e:\X` count as the same project. */
function canon(p: string): string {
  const k = pathKey(p);
  let c = canonical.get(k);
  if (!c) {
    try {
      c = realpathSync.native(p);
    } catch {
      c = p;
    }
    canonical.set(k, c);
  }
  return c;
}

export function projectRootOf(p: string): string | null {
  if (/[*?]/.test(p)) return null; // glob patterns, not real paths
  const root = repoRootOf(p) ?? workspaceChildOf(p);
  return root && canon(root);
}
