// `init` (ROADMAP.md template) and `skill install|uninstall` (Claude Code skill).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import skillTemplate from '../skill/SKILL.md';
import { docTodos, draftRoadmap, gitCommits } from './draft.ts';
import { ROADMAP_FILE } from './history.ts';
import { installPromptHook, uninstallPromptHook } from './hook.ts';
import { repoRootOfPath } from './repo.ts';

export function roadmapTemplate(name: string, today: string): string {
  return `# ROADMAP · ${name}
stage: prototype

<!--
  The source of truth for what's done and what's left. scopeburn draws the burn-up from this file's git history.
  - [ ] open   - [x] done   - [-] cut (add " — reason")
  {ID}        unique, never renamed (history and cost tracking key on it)
  ~S ~M ~L ~XL  size: half a day / a day / a few days / a week or more
  @decided(YYYY-MM-DD) @start(...) @paused(...) @done(...) @cut(...)  all optional; dates fill in the history
  stage: idea | prototype | mvp | beta | released | maintenance
-->

## First milestone
- [ ] {first} Describe the first thing to build ~M @decided(${today})
`;
}

export interface InitOptions {
  /** template only, no git draft */
  blank?: boolean;
  /** print the draft instead of writing it */
  print?: boolean;
  days?: number;
}

export function initRoadmap(dir: string, o: InitOptions = {}): string {
  const root = repoRootOfPath(path.resolve(dir)) ?? path.resolve(dir);
  const file = path.join(root, ROADMAP_FILE);
  if (existsSync(file) && !o.print) return `${file} already exists; left unchanged`;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const commits = o.blank ? [] : gitCommits(root, o.days ?? 90);
  const todos = o.blank ? [] : docTodos(root);
  const md = commits.length || todos.length ? draftRoadmap(commits, todos, { name: path.basename(root), today }) : roadmapTemplate(path.basename(root), today);
  if (o.print) return md;
  writeFileSync(file, md);
  const items = (md.match(/^\s*- \[[ x-]\]/gm) ?? []).length;
  return commits.length || todos.length
    ? `wrote ${file}: ${items} items drafted from ${commits.length} commits and ${todos.length} doc to-dos. Review the names, sizes and grouping, then commit.`
    : `wrote ${file} (template; no recent commits to draft from)`;
}

function skillDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.split(path.delimiter).find(Boolean) ?? path.join(os.homedir(), '.claude');
  return path.join(base, 'skills', 'scopeburn');
}

/** The command the skill should run: this script by absolute path, so it works without a global install. */
export function cliCommand(): string {
  return `node "${path.resolve(process.argv[1])}"`;
}

export function renderSkill(cmd: string): string {
  return skillTemplate.replaceAll('{{CMD}}', cmd);
}

export function installSkill(): string {
  const dir = skillDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (prev && !prev.includes('name: scopeburn')) return `${file} exists and isn't scopeburn's; left unchanged`;
  writeFileSync(file, renderSkill(cliCommand()));
  // The skill and the prompt hook work as a pair: the hook catches planning moments the skill might miss.
  return `skill ${prev ? 'updated' : 'installed'}: ${file}\nprompt hook ${installPromptHook()}`;
}

export function uninstallSkill(): string {
  const dir = skillDir();
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes('name: scopeburn')) return 'scopeburn skill is not installed';
  rmSync(dir, { recursive: true });
  return `skill removed: ${dir}\nprompt hook: ${uninstallPromptHook()}`;
}
