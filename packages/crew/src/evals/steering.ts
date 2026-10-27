/**
 * S5 steering firing, folded from the steering evals the daemon already runs (core `governanceEvals`, stored by
 * crew's eval-store). No second mechanism: the latest stored run's per-sample results become cases. The built-in
 * dev-behaviors corpus is synthetic by nature; an imported `evals:<name>` corpus is the operator's own (real).
 */

import type { EvalRunDetail } from '../core/types.js';
import type { EvalCase } from './types.js';

export function steeringCasesFrom(detail: EvalRunDetail | null): EvalCase[] {
  if (detail === null) return [];
  const real = detail.corpus !== null;
  return detail.results.map((r) => ({
    id: `steering:eval:${detail.id}:${r.sample.id}`,
    suite: 'steering' as const,
    source: real ? ('real' as const) : ('synthetic' as const),
    project: null,
    inputKey: `steering:${r.sample.steering_type}:${r.sample.id}`,
    input: { sample: r.sample.id, steering_type: r.sample.steering_type, corpus: detail.corpus ?? 'built-in' },
    observed: { label: r.fired.length > 0 ? 'block' : 'allow', by: 'replay' as const },
    expected: {
      label: r.expected === 'deny' ? 'block' : 'allow',
      by: real ? ('operator' as const) : ('fixture' as const),
      why: `a ${r.sample.kind} sample`,
    },
  }));
}
