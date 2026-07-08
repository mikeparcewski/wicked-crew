#!/usr/bin/env node
// Usage: node mock-worker.mjs [--exit <code>] [--verdict <PASS|CONDITIONAL|FAIL>] [--council] [--delay <ms>]
import { argv } from 'node:process';

const exitIdx = argv.indexOf('--exit');
const verdictIdx = argv.indexOf('--verdict');
const delayIdx = argv.indexOf('--delay');
const exitCode = exitIdx >= 0 ? parseInt(argv[exitIdx + 1] ?? '0') : 0;
const verdict = verdictIdx >= 0 ? (argv[verdictIdx + 1] ?? 'PASS') : 'PASS';
const delayMs = delayIdx >= 0 ? parseInt(argv[delayIdx + 1] ?? '0') : 0;
const council = argv.includes('--council');

const output = {
  status: exitCode === 0 ? 'ok' : 'error',
  artifact: {
    acceptance_criteria: [{ id: 'AC-001', text: 'fixture criterion' }],
    raid_items: [],
  },
  test_verdict: verdict,
  ...(council
    ? {
        votes: {
          recommendation: 'option-a',
          confidence: 0.9,
          rationale: 'fixture rationale',
          dimensions: {
            feasibility: 'agree',
            risk: 'disagree',
            alignment_with_goal: 'agree',
          },
        },
      }
    : {}),
};

function finish() {
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(exitCode);
}

if (delayMs > 0) {
  setTimeout(finish, delayMs);
} else {
  finish();
}
