/**
 * Read-only view over a repo's QE evidence ledger (wicked-ledger).
 *
 * The ledger is the data contract between the QE pipeline (wicked-garden's qe
 * skills, formerly wicked-testing) and the acceptance gate this daemon owns:
 * a DomainStore rooted at `<repo>/.wicked-testing/` holding `runs` and
 * `verdicts`, plus the public evidence manifest at
 * `<root>/evidence/<run-id>/manifest.json`. This module reads that state
 * through the wicked-ledger package API (public entry, no deep imports) and
 * never writes a domain record — the QE pipeline is the only writer.
 *
 * ONE deliberate mutation is allowed: `rebuildIndex()`, which regenerates the
 * store's DERIVED SQLite index from the canonical JSON files when the two
 * disagree (see `readAcceptanceState`). Canonical JSON is authoritative by the
 * ledger's own schema contract; the index is a cache, and rebuilding a cache
 * is not a write to the ledger's record of what happened.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDomainStore } from 'wicked-ledger';
import type { EvidenceManifest, RunRecord, VerdictRecord } from 'wicked-ledger';

/**
 * The ledger root directory name under a repo root.
 *
 * `.wicked-testing` is the wire contract today — the path garden's qe skills
 * write and every downstream consumer reads. Phase 6c renames it as part of
 * the wicked-testing retirement, which is why this is a single configurable
 * constant rather than a literal at each use site: when 6c lands, the flip is
 * one default (or one env var during the transition), not a grep.
 */
export const DEFAULT_QE_LEDGER_DIRNAME = '.wicked-testing';

/** The configured ledger dir name: `WICKED_QE_LEDGER_DIR` env override, else the default. */
export function qeLedgerDirName(): string {
  const env = process.env['WICKED_QE_LEDGER_DIR']?.trim();
  return env !== undefined && env !== '' ? env : DEFAULT_QE_LEDGER_DIRNAME;
}

/** Absolute ledger root for a repo. */
export function qeLedgerRoot(repoRoot: string): string {
  return join(repoRoot, qeLedgerDirName());
}

/**
 * The acceptance-relevant slice of a repo's ledger.
 *
 * `found: false` means the repo has no ledger at all (the dir is absent) —
 * a distinct fact from "a ledger with no verdicts", and the gate treats both
 * as a deny with different reasons. `error` carries a read-layer failure
 * (store threw); it is never set on an ordinary empty ledger.
 */
export interface QeAcceptanceState {
  /** Absolute ledger root that was read (or probed). */
  root: string;
  /** Whether the ledger root exists on disk. */
  found: boolean;
  /** The QE run the verdict belongs to, when resolvable. */
  run: RunRecord | null;
  /** The governing verdict row — newest first, the ledger's system of record. */
  verdict: VerdictRecord | null;
  /** The public evidence manifest for that run, when present and parseable. */
  manifest: EvidenceManifest | null;
  /** Absolute path the manifest was read from (null when absent). */
  manifestPath: string | null;
  /** Read-layer failure detail (store open/read threw). */
  error?: string;
}

/** True when the canonical JSON dir for a table has at least one record file. */
function hasCanonicalRows(root: string, table: string): boolean {
  try {
    return readdirSync(join(root, table)).some(
      (f) => f.endsWith('.json') && !f.includes('.tmp.'),
    );
  } catch {
    return false;
  }
}

/**
 * Read the ledger's current acceptance state for a repo.
 *
 * The newest verdict row governs (`opts.qeRunId` narrows to one QE run's
 * newest verdict instead). The verdicts TABLE is the system of record — the
 * manifest is the public artifact built from it at run finalization, returned
 * here as display evidence, never as a gate input: a run can legitimately be
 * re-reviewed after its manifest was built, and the newer verdict row wins.
 *
 * Index-drift healing: the store is dual-write (canonical JSON + a derived
 * SQLite index) and a writer that degraded to JSON-only leaves the index
 * behind. When the index answers "no verdicts" but canonical verdict files
 * exist, the index is provably stale, so it is rebuilt from JSON once and
 * re-read — otherwise a ledger full of evidence would read as "missing
 * evidence ⇒ deny", a wrong answer in the honest direction but still wrong.
 */
export async function readAcceptanceState(
  repoRoot: string,
  opts?: { qeRunId?: string },
): Promise<QeAcceptanceState> {
  const root = qeLedgerRoot(repoRoot);
  const state: QeAcceptanceState = {
    root,
    found: false,
    run: null,
    verdict: null,
    manifest: null,
    manifestPath: null,
  };
  // Probe before opening: createDomainStore CREATES its root when absent, and
  // a read must not install an empty ledger into a repo that never had one.
  if (!existsSync(root)) return state;
  state.found = true;

  try {
    const store = createDomainStore({ root });
    const filter = opts?.qeRunId !== undefined ? { run_id: opts.qeRunId } : undefined;
    let verdicts = store.list('verdicts', filter);
    if (verdicts.length === 0 && store.mode === 'sqlite+json' && hasCanonicalRows(root, 'verdicts')) {
      store.rebuildIndex();
      verdicts = store.list('verdicts', filter);
    }
    const verdict = verdicts[0] ?? null;
    state.verdict = verdict;
    if (verdict !== null) {
      state.run = store.get('runs', verdict.run_id);
      state.manifestPath = join(root, 'evidence', verdict.run_id, 'manifest.json');
      state.manifest = await readManifest(state.manifestPath);
    }
  } catch (err) {
    // A ledger that exists but cannot be read is NOT "no evidence" — the gate
    // still denies (deny-dominates), but the reason must name the read failure
    // so an operator fixes the store instead of hunting for a missing run.
    state.error = err instanceof Error ? err.message : String(err);
  }
  return state;
}

/** Parse the public manifest, or null when absent/malformed (display evidence only). */
async function readManifest(path: string): Promise<EvidenceManifest | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as EvidenceManifest;
    // Minimal shape check — enough to know this is a manifest and not stray JSON.
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.run_id !== 'string' || typeof parsed.manifest_version !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The summary of a manifest the acceptance route serves (never the full artifact list). */
export interface QeManifestSummary {
  manifestVersion: string;
  runId: string;
  scenarioName: string | null;
  status: string;
  artifactCount: number;
  verdict: { value: string; reviewer: string; recordedAt: string | null };
}

/** Reduce a manifest to the route's summary shape. */
export function summarizeManifest(manifest: EvidenceManifest): QeManifestSummary {
  return {
    manifestVersion: manifest.manifest_version,
    runId: manifest.run_id,
    scenarioName: typeof manifest.scenario_name === 'string' ? manifest.scenario_name : null,
    status: manifest.status,
    artifactCount: Array.isArray(manifest.artifacts) ? manifest.artifacts.length : 0,
    verdict: {
      value: manifest.verdict?.value ?? 'INCONCLUSIVE',
      reviewer: manifest.verdict?.reviewer ?? '',
      recordedAt: manifest.verdict?.recorded_at ?? null,
    },
  };
}
