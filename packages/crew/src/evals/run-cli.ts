#!/usr/bin/env node
/**
 * `run-evals` (DES-DEFAULT-EVALS-001 §7): the Tool step of the `run-evals` workflow, and a plain command.
 *
 *   node dist/evals/run-cli.js [--daemon <url>] [--project <id>|all] [--baseline] [--out <file>]
 *
 * The daemon is `--daemon`, else `$WICKED_CREW_URL` (the daemon exports it to its children, so the workflow's Tool
 * step reaches the daemon that launched it). With neither, it refuses: it never guesses a port.
 *
 * It asks the daemon to run the default evals (`POST /api/v1/testing/default-evals/run`), so the daemon's own store
 * is what gets scored and the report is stored where studio reads it. It prints a short plain summary, writes the
 * full report to `--out` when given, and exits 0 on a completed run (a regression is a finding, not a failure),
 * 1 when the daemon refused or could not be reached.
 */

import { writeFileSync } from 'node:fs';

import type { DefaultEvalReport } from './types.js';

export interface CliArgs {
  /** `null` until named: the CLI never guesses a port, since a default could reach another daemon. */
  daemon: string | null;
  project: string | null;
  baseline: boolean;
  out: string | null;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = {
    daemon: env['WICKED_CREW_URL'] !== undefined && env['WICKED_CREW_URL'] !== '' ? env['WICKED_CREW_URL'].replace(/\/+$/, '') : null,
    project: null,
    baseline: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--daemon') args.daemon = next().replace(/\/+$/, '');
    else if (a === '--project') {
      const p = next();
      args.project = p === 'all' ? null : p;
    } else if (a === '--baseline') args.baseline = true;
    else if (a === '--out') args.out = next();
    else throw new Error(`unknown argument ${String(a)}`);
  }
  return args;
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

/** The plain summary: one line per suite, too-few marked, then the drift keys. */
export function summaryLines(r: DefaultEvalReport): string[] {
  const lines = [
    `default evals ${r.id} (${r.project ?? 'every project'}): ${r.counts.real} real, ${r.counts.synthetic} synthetic` +
      `${r.counts.baseline > 0 ? `, ${r.counts.baseline} from the shipped baseline` : ''}, ${r.counts.unscored} not scored`,
  ];
  for (const s of r.suites) {
    const a = s.combined.agreement;
    const figure = a.n === 0 ? 'no cases' : a.tooFew ? `too few cases (n=${a.n})` : `${pct(a.value)} agree (${pct(a.lo)}–${pct(a.hi)}, n=${a.n})`;
    lines.push(`  ${s.suite}: ${figure}; trend ${s.trend.word}`);
  }
  for (const d of r.drift) {
    lines.push(`  drift ${d.suite} ${d.inputKey} by ${d.axis}: ${Object.entries(d.observed).map(([p, v]) => `${p}=${v.join('|')}`).join(', ')}`);
  }
  return lines;
}

export async function main(argv: readonly string[], fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`run-evals: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (args.daemon === null) {
    process.stderr.write('run-evals: no daemon named: pass --daemon <url> or set WICKED_CREW_URL (it never guesses a port)\n');
    return 1;
  }
  const body = { ...(args.project !== null ? { project: args.project } : {}), ...(args.baseline ? { baseline: true } : {}) };
  let res: Response;
  try {
    res = await fetchImpl(`${args.daemon}/api/v1/testing/default-evals/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(`run-evals: the daemon at ${args.daemon} did not answer: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!res.ok) {
    process.stderr.write(`run-evals: the daemon refused (${res.status}): ${(await res.text()).slice(0, 300)}\n`);
    return 1;
  }
  const report = (await res.json()) as DefaultEvalReport;
  if (args.out !== null) writeFileSync(args.out, JSON.stringify(report, null, 2));
  process.stdout.write(`${summaryLines(report).join('\n')}\n`);
  return 0;
}

if (process.argv[1] !== undefined && /run-cli\.(js|ts)$/.test(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
