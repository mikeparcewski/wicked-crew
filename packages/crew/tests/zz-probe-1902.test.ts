// THROWAWAY (never merged): coord-approved probe for crew#1902 (publish a plan edited at its gate). It runs a compose
// through the real engine (stub runner; CI builds core-ts from core main), edits its plan at the gate (with and without
// a note) or approves it, confirms it to completion, and prints each run view, base64 JSON, one line per case. With a
// bus attached the stub team run does not get past its PA step (lane probe), so the proof publish reads is the view.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

import { composeInstructions, reviewInstructions } from '../src/api/product.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';


type Mode = 'edit' | 'note' | 'plain' | 'approvenote';

async function probe(mode: Mode): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'probe1902-'));
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  const project = await adapter.projectCreate(`publish-probe-${mode}`);
  const PID = project.id;
  const rows = [{ repoId: 'repo-a', key: 'REQ-1', title: 'Sign in', statement: 'A user signs in with email.' }, { repoId: 'repo-a', key: 'REQ-2', title: 'Sign out', statement: 'A user signs out.' }];
  const draft = composeInstructions(PID, rows, undefined);
  const review = reviewInstructions(PID, rows);
  const SEATS = JSON.stringify([
    { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
    { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
  ]);
  const runId = await adapter.launchRun({
    problem: `Compose the product plan for project ${PID} (2 requirement(s))`, sessionId: `run-compose-${mode}`, clisJson: SEATS, projectId: PID, deliver: 'none', humanConfirm: 'before:1',
    plan: { steps: [{ catalog: 'produce', id: 'draft', instructions: draft }, { catalog: 'critique', id: 'review', gate: { human_confirm: { unconditional: true } }, instructions: review }] },
  } as never);
  const seen: string[] = [];
  let first = true;
  let view = await adapter.runView(runId);
  for (let i = 0; i < Number(process.env["PROBE_ITERS"] ?? 80); i++) {
    view = await adapter.runView(runId);
    const st = view?.session.status ?? 'none';
    if (seen.at(-1) !== st) seen.push(st);
    if (st === 'completed' || st === 'cancelled' || st === 'failed') break;
    if (st === 'awaiting_human') {
      const tp = (view?.session as unknown as { team_plan?: { pending?: { steps?: { steps?: Array<Record<string, unknown>> } } } }).team_plan;
      const held = tp?.pending?.steps?.steps ?? [];
      if (first && (mode === 'edit' || mode === 'note') && held.length > 0) {
        const steps = held.filter((x) => x['added_by'] !== 'floor')
          .map((x) => (x['id'] === 'draft' ? { ...x, instructions: `${String(x['instructions'])}\n\nAlso add an epic for billing.` } : x))
          .map((x) => { const rest = { ...x }; delete rest['added_by']; delete rest['floor_reason']; return rest; });
        await adapter.confirmGate(runId, true, mode === 'note' ? 'Keep billing small.' : undefined, mode === 'note' ? 'edit_plan' : undefined, undefined, { steps } as never)
          .catch((e: unknown) => seen.push(`confirm-err:${String(e).slice(0, 200)}`));
        seen.push('edited');
      } else if (first && mode === 'approvenote') {
        await adapter.confirmGate(runId, true, 'Keep billing small.').catch((e: unknown) => seen.push(`confirm-err:${String(e).slice(0, 200)}`));
        seen.push('approved-with-note');
      } else {
        await adapter.confirmGate(runId, true).catch((e: unknown) => seen.push(`confirm-err:${String(e).slice(0, 200)}`));
        seen.push('confirmed');
      }
      first = false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const record = { _probe: `crew#1902 ${mode}`, projectId: PID, draft, review, statuses: seen, view, draftOutput: await adapter.workOutput(`${runId}:draft`) };
  const out = process.env['PROBE_1902_OUT'];
  if (out !== undefined && out !== '') writeFileSync(join(out, `probe-1902-${mode}.json`), JSON.stringify(record, null, 2));
  else console.log(`PROBE-1902-${mode.toUpperCase()} ${Buffer.from(JSON.stringify(record)).toString('base64')}`);
  adapter.close();
  removeScratch(dir);
}

it('probe: compose edited at its plan gate, with its team record (crew#1902)', { timeout: 300_000 }, () => probe('edit'));
it('probe: compose edited at its plan gate with a note (crew#1902 Q1)', { timeout: 300_000 }, () => probe('note'));
it('probe: compose approved at its plan gate unedited (crew#1902 baseline)', { timeout: 300_000 }, () => probe('plain'));
it('probe: compose approved at its plan gate with a note, unedited (crew#1902 pre-existing)', { timeout: 300_000 }, () => probe('approvenote'));
