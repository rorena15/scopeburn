// API-equivalent cost of a usage record, from data/prices.json (overridable per user).
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import defaults from '../data/prices.json' with { type: 'json' };
import { dataDir } from './cache.ts';
import type { Usage } from './logs.ts';

interface Rates {
  input: number;
  output: number;
  write5m: number;
  write1h: number;
  read: number;
}

interface ModelPrice extends Rates {
  fastMultiplier?: number;
  longPrompt?: Rates & { overTokens: number };
}

export interface PriceTable {
  source: string;
  checked: string;
  webSearchPerRequest: number;
  usGeoMultiplier: number;
  models: Record<string, ModelPrice>;
}

export function loadPrices(): PriceTable {
  const table = structuredClone(defaults) as PriceTable;
  try {
    const o = JSON.parse(readFileSync(path.join(dataDir(), 'prices.override.json'), 'utf8')) as Partial<PriceTable>;
    Object.assign(table.models, o.models ?? {});
    if (typeof o.webSearchPerRequest === 'number') table.webSearchPerRequest = o.webSearchPerRequest;
    if (typeof o.usGeoMultiplier === 'number') table.usGeoMultiplier = o.usGeoMultiplier;
  } catch {}
  return table;
}

/** Strip provider prefixes and date suffixes: "anthropic.claude-haiku-4-5-20251001" -> "claude-haiku-4-5". */
export function normalizeModel(model: string): string {
  return model
    .replace(/^.*?\.(?=claude-)/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/[@-]\d{8}$/, '');
}

export function priceOf(table: PriceTable, model: string): ModelPrice | undefined {
  return table.models[normalizeModel(model)];
}

/** USD for one response, or null when the model has no price entry. */
export function costOf(table: PriceTable, model: string, u: Usage): number | null {
  const p = priceOf(table, model);
  if (!p) return null;
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const r: Rates = p.longPrompt && prompt > p.longPrompt.overTokens ? p.longPrompt : p;
  // Logs that predate the TTL split only give a total; price the unknown part at the 1h rate (the higher one).
  const unsplit = Math.max(0, u.cacheWrite - u.cacheWrite5m - u.cacheWrite1h);
  let usd =
    (u.input * r.input +
      u.output * r.output +
      u.cacheRead * r.read +
      u.cacheWrite5m * r.write5m +
      (u.cacheWrite1h + unsplit) * r.write1h) /
    1e6;
  if (u.fast) usd *= p.fastMultiplier ?? 1;
  if (u.geoUS) usd *= table.usGeoMultiplier;
  return usd + u.webSearch * table.webSearchPerRequest;
}
