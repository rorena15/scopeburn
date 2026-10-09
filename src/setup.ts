// `init` (ROADMAP.md template) and `skill install|uninstall` (Claude Code skill).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import skillTemplate from '../skill/SKILL.md';
import { ROADMAP_FILE } from './history.ts';
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

export function initRoadmap(dir: string): string {
  const root = repoRootOfPath(path.resolve(dir)) ?? path.resolve(dir);
  const file = path.join(root, ROADMAP_FILE);
  if (existsSync(file)) return `${file} already exists; left unchanged`;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  writeFileSync(file, roadmapTemplate(path.basename(root), today));
  return `wrote ${file}`;
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
  return `${prev ? 'updated' : 'installed'} ${file}`;
}

export function uninstallSkill(): string {
  const dir = skillDir();
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes('name: scopeburn')) return 'scopeburn skill is not installed';
  rmSync(dir, { recursive: true });
  return `removed ${dir}`;
}
