/**
 * WT-W1 (DES-walkthrough-proof §4.2, O7): where a run's EVIDENCE ROOT lives. Crew mints one per
 * repo-bound run at launch (`CoreAdapter.launchRun`) and hands it to the engine as
 * `LaunchOptions.evidenceRoot`; the engine persists it as `session.evidence_root`.
 *
 *   <root>/author/<plan step>/   the walkthrough author's write dir — `<root>/author` is the ONLY
 *                                path crew lists in the launch's `extraWriteRoots`
 *   <root>/<review step>/        the PROOF ROOT, written only by the jailed `walkthrough_review` Tool
 *
 * One directory per run, outside every sandbox and state home (the demo-root pattern):
 * `$WICKED_WALKTHROUGH_DIR/<runId>`, default `<home>/.wicked/walkthroughs/<runId>`.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { SessionView, WorkUnit } from './types.js';

/** The subdirectory of an evidence root the walkthrough author writes under. */
export const WALKTHROUGH_AUTHOR_SUBDIR = 'author';

/**
 * A run id usable as ONE path segment (`[A-Za-z0-9._-]`, not starting with `.`, ≤ 128 chars) — the
 * engine's step-id rule. `POST /runs` takes a caller-chosen `sessionId`, so anything else (`../x`)
 * gets no evidence root rather than a directory outside `WICKED_WALKTHROUGH_DIR` (codex on #758).
 */
export function isPlainRunId(runId: string): boolean {
  return runId.length > 0 && runId.length <= 128 && !runId.startsWith('.') && /^[A-Za-z0-9._-]+$/.test(runId);
}

/** The run's evidence root. Throws for a run id that is not one plain path segment ({@link isPlainRunId}). */
export function walkthroughRootDir(runId: string): string {
  if (!isPlainRunId(runId)) throw new Error(`run id ${JSON.stringify(runId)} is not a plain path segment, so it has no evidence root`);
  if (process.env.WICKED_WALKTHROUGH_DIR) return join(process.env.WICKED_WALKTHROUGH_DIR, runId);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.wicked', 'walkthroughs', runId);
}

/** The step id of a unit (`<run>:<step>` → `<step>`). */
export function stepIdOf(view: SessionView, unit: WorkUnit): string {
  const prefix = `${view.session.id}:`;
  return unit.id.startsWith(prefix) ? unit.id.slice(prefix.length) : unit.id;
}

/**
 * The PROOF ROOT of a `walkthrough_review` step — `<session.evidence_root>/<step>` — only when it is a
 * plain directory directly under the evidence root (never through a planted link: the engine's
 * `check_proof_root` rule), and its step id is one plain path segment other than `author`. `null`
 * otherwise, and for a run with no evidence root.
 */
export async function walkthroughProofRoot(view: SessionView, review: WorkUnit): Promise<string | null> {
  const evidence = (view.session as { evidence_root?: unknown }).evidence_root;
  if (typeof evidence !== 'string' || evidence === '') return null;
  const step = stepIdOf(view, review);
  if (!/^[A-Za-z0-9._-]+$/.test(step) || step.startsWith('.') || step.toLowerCase() === WALKTHROUGH_AUTHOR_SUBDIR) return null;
  const dir = join(evidence, step);
  try {
    const st = await fsp.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    const real = await fsp.realpath(dir);
    if (real !== join(await fsp.realpath(evidence), step)) return null;
    return real;
  } catch {
    return null;
  }
}
