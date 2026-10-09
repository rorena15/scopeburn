// User settings in ~/.scopeburn/config.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { dataDir } from './cache.ts';

export interface Config {
  /** how Claude is paid for; null until the user says */
  billing: 'subscription' | 'api' | null;
  /** subscription plan label, e.g. "pro", "max5", "max20" */
  plan: string | null;
  /** monthly subscription fee in USD, for the "used N× your fee" figure */
  monthlyFeeUsd: number | null;
  /** display currency besides USD, with a fixed rate the user sets */
  currency: string | null;
  ratePerUsd: number | null;
  /** status line command that was in place before ours; we run it and pass its output through */
  statuslineWrapped: string | null;
}

const DEFAULTS: Config = {
  billing: null,
  plan: null,
  monthlyFeeUsd: null,
  currency: null,
  ratePerUsd: null,
  statuslineWrapped: null,
};

const file = () => path.join(dataDir(), 'config.json');

export function loadConfig(): Config {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(c: Config) {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`);
  renameSync(tmp, file());
}
