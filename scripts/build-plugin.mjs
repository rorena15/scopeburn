// Renders the Claude Code plugin from skill/SKILL.md, with the skill calling the published CLI via npx.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const skill = readFileSync('skill/SKILL.md', 'utf8').replaceAll('{{CMD}}', 'npx -y scopeburn@latest');
mkdirSync('plugin/.claude-plugin', { recursive: true });
mkdirSync('plugin/skills/scopeburn', { recursive: true });
writeFileSync('plugin/skills/scopeburn/SKILL.md', skill);
writeFileSync(
  'plugin/.claude-plugin/plugin.json',
  `${JSON.stringify({ name: 'scopeburn', version: pkg.version, description: pkg.description, license: pkg.license }, null, 2)}\n`,
);
console.log('plugin/ rendered');
