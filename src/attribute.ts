// Assigns each usage record to repositories.
// Order: the response's own tool paths → its turn → its subagent run → its session → cwd → unattributed.
import type { UsageRecord } from './logs.ts';

export const UNATTRIBUTED = '(unattributed)';

export type Level = 'direct' | 'turn' | 'agent' | 'session' | 'cwd' | 'none';

export interface Share {
  repo: string;
  /** fraction of the record assigned to this repo, 0..1 */
  weight: number;
}

export interface Attributed {
  rec: UsageRecord;
  shares: Share[];
  level: Level;
}

type Counts = Map<string, Map<string, number>>;

function bump(m: Counts, scope: string, repos: Record<string, number>) {
  let c = m.get(scope);
  if (!c) m.set(scope, (c = new Map()));
  for (const [r, n] of Object.entries(repos)) c.set(r, (c.get(r) ?? 0) + n);
}

function majority(c: Map<string, number> | undefined): string | null {
  if (!c || c.size === 0) return null;
  let best: string | null = null;
  let bestN = -1;
  for (const [r, n] of c) if (n > bestN) [best, bestN] = [r, n];
  return best;
}

export function attribute(records: UsageRecord[]): Attributed[] {
  const byTurn: Counts = new Map();
  const byAgent: Counts = new Map();
  const bySession: Counts = new Map();
  const agentScope = (r: UsageRecord) => `${r.session}/${r.agent ?? ''}`;
  for (const r of records) {
    bump(byTurn, r.turn, r.repos);
    bump(byAgent, agentScope(r), r.repos);
    bump(bySession, r.session, r.repos);
  }

  return records.map((rec) => {
    const own = Object.entries(rec.repos);
    if (own.length) {
      const total = own.reduce((s, [, n]) => s + n, 0);
      return { rec, level: 'direct', shares: own.map(([repo, n]) => ({ repo, weight: n / total })) };
    }
    const tries: [Level, string | null][] = [
      ['turn', majority(byTurn.get(rec.turn))],
      ['agent', rec.agent ? majority(byAgent.get(agentScope(rec))) : null],
      ['session', majority(bySession.get(rec.session))],
      ['cwd', rec.cwdRepo],
    ];
    for (const [level, repo] of tries) if (repo) return { rec, level, shares: [{ repo, weight: 1 }] };
    return { rec, level: 'none', shares: [{ repo: UNATTRIBUTED, weight: 1 }] };
  });
}
