// UserPromptSubmit hook: when a message plans, designs, decides or approves work, remind Claude
// to record it in ROADMAP.md. The hook only adds context; Claude decides whether anything was decided.
// Runs on every prompt, so it must be fast and must never fail: no log parsing, all errors swallowed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROADMAP_FILE } from './history.ts';
import { repoRootOfPath } from './repo.ts';
import { writeJsonPreservingIndent } from './statusline.ts';

// Planning, design and decision words, plus short approvals ("진행해" right after a proposal is when work gets decided).
const TRIGGER =
  /설계|기획|계획|로드맵|마일스톤|우선순위|범위|스펙|요구사항|결정|정하자|정했|하기로|빼자|접자|보류|미루|나중에|추가하자|넣자|만들자|진행해|진행하자|가자|그렇게 하자|\b(plan|planning|design|roadmap|milestone|scope|spec|backlog|priorit\w*|decide\w*|let'?s (do|go|build|add)|go ahead|ship it|drop it|cut it|postpone)\b/i;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** ROADMAP.md files relevant to a working directory: its own project, else the projects directly under it. */
export function roadmapsNear(cwd: string): string[] {
  const out = new Set<string>();
  const root = repoRootOfPath(cwd);
  if (root && existsSync(path.join(root, ROADMAP_FILE))) out.add(path.join(root, ROADMAP_FILE));
  if (existsSync(path.join(cwd, ROADMAP_FILE))) out.add(path.join(cwd, ROADMAP_FILE));
  if (!out.size) {
    try {
      for (const e of readdirSync(cwd, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const f = path.join(cwd, e.name, ROADMAP_FILE);
        if (existsSync(f)) out.add(f);
      }
    } catch {}
  }
  return [...out];
}

export function promptContext(prompt: string, cwd: string): string | null {
  if (!TRIGGER.test(prompt)) return null;
  const files = roadmapsNear(cwd);
  if (!files.length) return null;
  const d = today();
  return [
    `[scopeburn] Roadmaps here: ${files.join(', ')}.`,
    'If this message (or the proposal it answers) decides, approves, designs, reprioritizes or drops work for one of these projects, update that ROADMAP.md as part of the same change:',
    `new work → \`- [ ] {new-id} title ~S|M|L|XL @decided(${d})\`; starting → add \`@start(${d})\`; finished → \`[x]\` + \`@done(${d})\`; dropped → \`[-]\` + \`@cut(${d}) — reason\`; blocked on someone else → \`@paused(${d})\`.`,
    'Never rename an existing {ID}. Say in one line what you changed in the roadmap. If nothing was decided, ignore this.',
  ].join(' ');
}

export async function promptHookMain() {
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const ctx = promptContext(String(input.prompt ?? ''), String(input.cwd ?? process.cwd()));
    if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
  } catch {} // never block or break the user's prompt
}

// ---- install / uninstall into Claude Code user settings ----

function settingsPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.split(path.delimiter).find(Boolean) ?? path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

const isOurs = (h: any) => typeof h?.command === 'string' && /scopeburn/.test(h.command) && /hook prompt/.test(h.command);

export function installPromptHook(): string {
  const file = settingsPath();
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
  const settings = JSON.parse(original);
  const cmd = `node "${path.resolve(process.argv[1])}" hook prompt`;
  settings.hooks ??= {};
  const list: any[] = (settings.hooks.UserPromptSubmit ??= []);
  for (const group of list) {
    const h = (group.hooks ?? []).find(isOurs);
    if (h) {
      if (h.command === cmd) return `already installed in ${file}`;
      h.command = cmd; // the script moved
      writeJsonPreservingIndent(file, original, settings);
      return `updated in ${file}`;
    }
  }
  list.push({ hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  writeJsonPreservingIndent(file, original, settings);
  return `installed in ${file}`;
}

export function uninstallPromptHook(): string {
  const file = settingsPath();
  if (!existsSync(file)) return 'no Claude Code settings file found';
  const original = readFileSync(file, 'utf8');
  const settings = JSON.parse(original);
  const list: any[] | undefined = settings.hooks?.UserPromptSubmit;
  if (!list?.some((g) => (g.hooks ?? []).some(isOurs))) return 'scopeburn prompt hook is not installed';
  settings.hooks.UserPromptSubmit = list
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) }))
    .filter((g) => g.hooks.length);
  if (!settings.hooks.UserPromptSubmit.length) delete settings.hooks.UserPromptSubmit;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeJsonPreservingIndent(file, original, settings);
  return `removed from ${file}`;
}
