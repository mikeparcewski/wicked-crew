import type { PolicyRule } from '../types.js';

export const builtInPolicies: PolicyRule[] = [
  {
    name: 'worker-exit-success',
    conditions: {
      all: [{ fact: 'worker_all_success', operator: 'equal', value: true }],
    },
    event: { type: 'worker-exit-success' },
  },
  {
    name: 'no-blocking-raid',
    conditions: {
      all: [{ fact: 'blocking_raid_count', operator: 'equal', value: 0 }],
    },
    event: { type: 'no-blocking-raid' },
  },
  {
    name: 'test-verdict-pass',
    conditions: {
      any: [
        { fact: 'test_verdict', operator: 'equal', value: null },
        { fact: 'test_verdict', operator: 'equal', value: 'PASS' },
        { fact: 'test_verdict', operator: 'equal', value: 'CONDITIONAL' },
      ],
    },
    event: { type: 'test-verdict-pass' },
  },
];
