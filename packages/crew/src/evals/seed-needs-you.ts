/**
 * S1 needs-you, seeded from the operator's ruling on one live snapshot (rig crew 0.16.3, 2026-10-27T04:11:50Z,
 * GET only): "the number is how many distinct causes are holding work up right now" (the needs-you DEFINITION).
 * The ruled answer is 5 items over 6 runs. Each item below is asked of four answerers:
 *
 *  - `home`: studio's Home badge (`attentionBadge`: gate rows minus ask turns, plus failed runs) said 21;
 *  - `needs-page`: studio's /needs headline (`needCount` over every fold row, proposals included) said 51;
 *  - `nerve-center`: crew `GET /system` `attention[]` said 12 at the dump (11 on the screenshot);
 *  - `codex`: the codex CLI, given the same dump read-only, said 7 (it would not merge the core red-base runs).
 *
 * The surfaces never merge, so each counted row is its own cluster there. These are real cases labelled by the
 * operator; a live capture replaces them once needs-one's Resolve records operator answers.
 */

import type { EvalCase } from './types.js';

type Surface = 'home' | 'needs-page' | 'nerve-center' | 'codex';
const SURFACES: Surface[] = ['home', 'needs-page', 'nerve-center', 'codex'];

interface Item {
  id: string;
  kind: string;
  /** The ruled cluster when it counts; `null` when it is not in the number. */
  cluster: string | null;
  why: string;
  /** Which answerers counted it, and the cluster codex gave it. */
  countedBy: Surface[];
  codexCluster?: string;
}

const TINY_MATH_FAILED = ['89da69fb', '1ff74953', 'c2bc93a0', 'dcc4547b', 'e2c2cd4d', '6dd64a52', 'b979f42c', '7bbaab3a', 'bb505ad8', '449f566e', '4b517e33', '78cf6482', '11b1b4ea'];

const ITEMS: Item[] = [
  { id: 'infra:load', kind: 'infra', cluster: 'host-load', why: 'the host is overloaded: system slowing', countedBy: ['nerve-center', 'codex'], codexCluster: 'host-load' },
  { id: '29bcace4', kind: 'deliver gate', cluster: 'core-red-base', why: 'the fix for core’s red base waits at its deliver gate', countedBy: ['home', 'needs-page', 'nerve-center', 'codex'], codexCluster: '29bcace4' },
  { id: '1940f173', kind: 'escalation', cluster: 'core-red-base', why: 'held by core’s red base', countedBy: ['home', 'needs-page', 'nerve-center', 'codex'], codexCluster: '1940f173' },
  { id: '2ebd9da2', kind: 'escalation', cluster: 'core-red-base', why: 'held by core’s red base', countedBy: ['home', 'needs-page', 'nerve-center', 'codex'], codexCluster: '2ebd9da2' },
  { id: '64f05d3d', kind: 'escalation', cluster: 'crew-red-base', why: 'crew’s base is red and cannot be separated', countedBy: ['home', 'needs-page', 'nerve-center', 'codex'], codexCluster: '64f05d3d' },
  { id: '290a7fee', kind: 'escalation', cluster: 'dead-seat', why: 'a dead seat with no failover', countedBy: ['home', 'needs-page', 'nerve-center', 'codex'], codexCluster: '290a7fee' },
  { id: '68c26704', kind: 'escalation (ask)', cluster: 'ask-refused', why: 'an ask refused by input governance waits on the operator', countedBy: ['nerve-center', 'codex'], codexCluster: '68c26704' },
  { id: '7f4e149f', kind: 'deliver gate', cluster: null, why: 'superseded: the same repo and title was delivered later', countedBy: ['home', 'needs-page', 'nerve-center'] },
  { id: '9bd0f728', kind: 'escalation', cluster: null, why: 'superseded: a retry names it and was delivered', countedBy: ['home', 'needs-page', 'nerve-center'] },
  { id: 'b87f42fb', kind: 'answered ask', cluster: null, why: 'an answered ask parked at its turn', countedBy: ['nerve-center'] },
  { id: 'e43c4560', kind: 'answered ask', cluster: null, why: 'an answered ask parked at its turn', countedBy: ['nerve-center'] },
  ...TINY_MATH_FAILED.map((id): Item => ({ id, kind: 'failed run', cluster: null, why: 'an old ad-hoc probe, failed over 7 days ago', countedBy: ['home', 'needs-page'] })),
  { id: '910e3e0b', kind: 'failed run', cluster: null, why: 'superseded by a delivered run', countedBy: ['home', 'needs-page'] },
  { id: 'cli:copilot', kind: 'benched seat', cluster: null, why: 'a self-expiring bench while a distinct judge is still available (info)', countedBy: ['nerve-center'] },
  { id: 'proposals', kind: 'pending proposals', cluster: null, why: 'reviews: nothing waits on them (to review, not in the number)', countedBy: ['needs-page'] },
];

export const NEEDS_YOU_SNAPSHOT = '2026-10-27T04:11:50Z';

export function needsYouSeed(): EvalCase[] {
  const out: EvalCase[] = [];
  for (const it of ITEMS) {
    for (const s of SURFACES) {
      const counted = it.countedBy.includes(s);
      const cluster = counted ? (s === 'codex' ? (it.codexCluster ?? it.id) : it.id) : undefined;
      out.push({
        id: `needs-you:${NEEDS_YOU_SNAPSHOT}:${s}:${it.id}`,
        suite: 'needs-you',
        source: 'real',
        project: null,
        surface: s,
        inputKey: `needs:${it.id}`,
        input: { item: it.id, kind: it.kind, snapshot: NEEDS_YOU_SNAPSHOT },
        observed: { label: counted ? 'count' : 'not', ...(cluster !== undefined ? { cluster } : {}), by: 'recorded' },
        expected: { label: it.cluster !== null ? 'count' : 'not', ...(it.cluster !== null ? { cluster: it.cluster } : {}), by: 'operator', why: it.why },
        evidence: { file: 'the needs-you DEFINITION ruling, 2026-10-27' },
        baseline: true,
      });
    }
  }
  return out;
}
