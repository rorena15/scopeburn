// Writes the dashboard (one self-contained HTML file) and serves a live copy on localhost.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';
import template from './report/template.html';
import type { ReportData } from './report-data.ts';

/** JSON safe to place inside a <script> element. */
function embed(data: ReportData): string {
  // Escape '<' (no early </script>) and U+2028/2029 (line terminators in older JS engines).
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  return JSON.stringify(data).replace(/</g, '\\u003c').split(ls).join('\\u2028').split(ps).join('\\u2029');
}

export function renderHtml(data: ReportData, live = false): string {
  let html = template.replace('/*__SCOPEBURN_DATA__*/', () => embed(data));
  if (live) html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="scopeburn-live" content="1">');
  return html;
}

/** Replace project names and item titles so the page can be shared without revealing them. */
export function redact(data: ReportData): ReportData {
  const d: ReportData = structuredClone(data);
  const names = new Map<string, string>();
  const alias = (n: string) => {
    if (n === '(unattributed)') return n;
    if (!names.has(n)) names.set(n, `project-${names.size + 1}`);
    return names.get(n)!;
  };
  d.dims.projects = d.dims.projects.map(alias);
  for (const p of d.projects) {
    p.name = alias(p.name);
    p.key = p.name;
    p.warnings = [];
    for (const it of p.items) {
      it.title = it.key.startsWith('~') ? 'item' : it.key;
      it.group = it.group ? 'group' : null;
    }
  }
  return d;
}

export function writeReport(file: string, data: ReportData) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderHtml(data));
}

export function openInBrowser(target: string) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).unref();
}

/** localhost-only server; data is rebuilt at most every `minIntervalMs`. */
export function serve(build: () => Promise<ReportData>, port: number, minIntervalMs = 30_000): Promise<string> {
  let cached: { at: number; data: ReportData } | null = null;
  let pending: Promise<ReportData> | null = null;
  const get = async () => {
    if (cached && Date.now() - cached.at < minIntervalMs) return cached.data;
    pending ??= build().finally(() => (pending = null));
    const data = await pending;
    cached = { at: Date.now(), data };
    return data;
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/data.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(await get()));
      } else if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderHtml(await get(), true));
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}/`));
  });
}
