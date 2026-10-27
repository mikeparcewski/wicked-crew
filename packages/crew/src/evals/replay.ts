/**
 * Replay adapters (DES-DEFAULT-EVALS-001 §4): the CURRENT classifier, run on a case's input, so synthetic cases can
 * be scored and real cases can show whether today's behaviour differs from what was recorded.
 *
 * Crew can replay only what it can call. The archetype classifier is garden's (`scripts/crew/archetypes_v11.py`,
 * stdlib-only Python), run as one batch per eval. The floor class, the QE verdict and builder attribution are decided
 * inside the engine (core) with no replay entry, so they have no adapter here and say so.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalCase, Observed, SuiteId } from './types.js';

export interface ReplayAdapter {
  suite: SuiteId;
  /** Answers for the cases it can replay, by case id. A case it could not answer is absent. */
  replay(cases: readonly EvalCase[]): Promise<Map<string, Observed>>;
}

export interface ReplaySet {
  adapters: Partial<Record<SuiteId, ReplayAdapter>>;
  /** Why a suite has no adapter, for the report's notes. */
  missing: Partial<Record<SuiteId, string>>;
}

/** The batch the garden classifier runs: JSON prompts on stdin, one `[label, confidence|null]` per prompt out. */
const ARCHETYPE_BATCH = `
import json, sys
sys.path.insert(0, sys.argv[1])
from archetypes_v11 import detect_archetypes
out = []
for p in json.loads(sys.stdin.read()):
    m = [x for x in detect_archetypes(prompt=p) if x[0] != "triage"]
    out.append([m[0][0], m[0][1]] if m else ["none", None])
sys.stdout.write(json.dumps(out))
`;

export type RunPython = (args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const runPython: RunPython = (args, stdin, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

/** The archetype adapter over a garden root, or `null` when the root has no classifier. */
export function archetypeAdapter(gardenRoot: string | null, run: RunPython = runPython): ReplayAdapter | null {
  if (gardenRoot === null) return null;
  const dir = join(gardenRoot, 'scripts', 'crew');
  if (!existsSync(join(dir, 'archetypes_v11.py'))) return null;
  return {
    suite: 'archetype',
    async replay(cases) {
      const out = new Map<string, Observed>();
      const todo = cases.filter((c) => typeof c.input['prompt'] === 'string');
      if (todo.length === 0) return out;
      const res = await run(['-I', '-c', ARCHETYPE_BATCH, dir], JSON.stringify(todo.map((c) => c.input['prompt'])), 30_000);
      if (res.code !== 0) throw new Error(`archetype classifier exited ${String(res.code)}: ${res.stderr.trim().slice(0, 200)}`);
      const rows = JSON.parse(res.stdout) as Array<[string, number | null]>;
      todo.forEach((c, i) => {
        const row = rows[i];
        if (row === undefined) return;
        out.set(c.id, { label: row[0], ...(typeof row[1] === 'number' ? { confidence: row[1] } : {}), by: 'replay' });
      });
      return out;
    },
  };
}

export const NO_REPLAY: Partial<Record<SuiteId, string>> = {
  'floor-class': 'the floor class is decided inside the engine (core), which has no replay entry yet',
  'qe-verdict': 'a QE verdict is a model’s judgment; only recorded verdicts are scored',
  attribution: 'authorship is decided inside the engine (core), which has no replay entry yet',
  'needs-you': 'the needs-you rule is being rebuilt in crew (needs-one); recorded surfaces are scored until it lands',
};

export function defaultReplaySet(opts: { gardenRoot: string | null; run?: RunPython }): ReplaySet {
  const missing: Partial<Record<SuiteId, string>> = { ...NO_REPLAY };
  const adapters: Partial<Record<SuiteId, ReplayAdapter>> = {};
  const a = archetypeAdapter(opts.gardenRoot, opts.run);
  if (a !== null) adapters.archetype = a;
  else missing.archetype = 'garden’s archetype classifier was not found (set WICKED_GARDEN_ROOT)';
  return { adapters, missing };
}
