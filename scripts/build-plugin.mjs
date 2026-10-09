// Renders the Claude Code plugin from skill/SKILL.md, with the skill calling the published CLI via npx.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const skill = readFileSync('skill/SKILL.md', 'utf8').replaceAll('{{CMD}}', 'npx -y scopeburn@latest');
mkdirSync('plugin/.claude-plugin', { recursive: true });
mkdirSync('plugin/skills/scopeburn', { recursive: true });
writeFileSync('plugin/skills/scopeburn/SKILL.md', skill);
// The prompt hook runs on every message, so it calls a bundled copy of the CLI rather than npx (too slow per prompt).
mkdirSync('plugin/bin', { recursive: true });
copyFileSync('dist/scopeburn.js', 'plugin/bin/scopeburn.js');
mkdirSync('plugin/hooks', { recursive: true });
writeFileSync(
  'plugin/hooks/hooks.json',
  `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/scopeburn.js" hook prompt', timeout: 5 }] }] } }, null, 2)}\n`,
);
writeFileSync(
  'plugin/.claude-plugin/plugin.json',
  `${JSON.stringify({ name: 'scopeburn', version: pkg.version, description: pkg.description, license: pkg.license }, null, 2)}\n`,
);
console.log('plugin/ rendered');
