// THROWAWAY (never merged): coord-approved probe for wicked-core#1929 (a plan edited at its gate reaches the units).
// CI builds core-ts from core main, so this runs the lane's compose-edit and compose-recat probes on core main and
// prints both run views (base64 JSON, one line each). The draft PR is closed once the views are captured.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

import { composeInstructions, reviewInstructions } from '../src/api/product.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

async function probeEdit(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'probe1929-'));
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  const project = await adapter.projectCreate('publish-probe-edit');
  const PID = project.id;
  const rows = [{ repoId: 'repo-a', key: 'REQ-1', title: 'Sign in', statement: 'A user signs in with email.' }, { repoId: 'repo-a', key: 'REQ-2', title: 'Sign out', statement: 'A user signs out.' }];
  const draft = composeInstructions(PID, rows, undefined);
  const review = reviewInstructions(PID, rows);
  const SEATS = JSON.stringify([
    { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
    { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
  ]);
  const runId = await adapter.launchRun({
    problem: `Compose the product plan for project ${PID} (2 requirement(s))`, sessionId: 'run-compose-edited', clisJson: SEATS, projectId: PID, deliver: 'none', humanConfirm: 'before:1',
    plan: { steps: [{ catalog: 'produce', id: 'draft', instructions: draft }, { catalog: 'critique', id: 'review', gate: { human_confirm: { unconditional: true } }, instructions: review }] },
  } as never);
  const seen: string[] = [];
  let edited = false;
  const gateLog: unknown[] = [];
  let view = await adapter.runView(runId);
  for (let i = 0; i < 60; i++) {
    view = await adapter.runView(runId);
    const st = view?.session.status ?? 'none';
    if (seen.at(-1) !== st) seen.push(st);
    if (st === 'completed' || st === 'cancelled' || st === 'failed') break;
    if (st === 'awaiting_human') {
      const edit = !edited;
      edited = true;
      const tp = (view?.session as unknown as { team_plan?: { pending?: { rev?: number; steps?: { steps?: Array<Record<string, unknown>> } }; accepted?: unknown } }).team_plan;
      if (edit) gateLog.push({ gate: 'first', team_plan_keys: Object.keys(tp ?? {}), pending: JSON.stringify(tp?.pending ?? null).slice(0, 600), units: view?.units.map((u) => [u.id, u.status, u.gate]) });
      const held = tp?.pending?.steps?.steps ?? [];
      const steps = held.length > 0
        ? held.filter((x) => x['added_by'] !== 'floor').map((x) => (x['id'] === 'draft' ? { ...x, instructions: `${String(x['instructions'])}\n\nAlso add an epic for billing.` } : x)).map((x) => { const rest = { ...x }; delete rest['added_by']; delete rest['floor_reason']; return rest; })
        : [{ catalog: 'produce', id: 'draft', instructions: `${draft}\n\nAlso add an epic for billing.` }, { catalog: 'critique', id: 'review', gate: { human_confirm: { unconditional: true } }, instructions: review }];
      const plan = { steps };
      await (edit ? adapter.confirmGate(runId, true, undefined, undefined, undefined, plan as never) : adapter.confirmGate(runId, true)).catch((e: unknown) => seen.push(`confirm-err:${String(e).slice(0, 160)}`));
      seen.push(edit ? 'edited' : 'confirmed');
      const after = await adapter.runView(runId);
      gateLog.push({ after: edit ? 'edit' : 'confirm', status: after?.session.status, rev: (after?.session as unknown as { team_plan?: { rev?: number } }).team_plan?.rev });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const record = { gateLog, projectId: PID, draft, review, statuses: seen, view, draftOutput: await adapter.workOutput(`${runId}:draft`) };
  // One line, so the CI log carries the whole view.
  console.log(`PROBE-1929-EDIT ${Buffer.from(JSON.stringify(record)).toString('base64')}`);
  adapter.close();
  removeScratch(dir);
}

async function probeRecat(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'probe1929-'));
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  const project = await adapter.projectCreate('publish-probe-recat');
  const PID = project.id;
  const rows = [{ repoId: 'repo-a', key: 'REQ-1', title: 'Sign in', statement: 'A user signs in with email.' }, { repoId: 'repo-a', key: 'REQ-2', title: 'Sign out', statement: 'A user signs out.' }];
  const draft = composeInstructions(PID, rows, undefined);
  const review = reviewInstructions(PID, rows);
  const SEATS = JSON.stringify([
    { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
    { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
  ]);
  const runId = await adapter.launchRun({
    problem: `Compose the product plan for project ${PID} (2 requirement(s))`, sessionId: 'run-compose-recat', clisJson: SEATS, projectId: PID, deliver: 'none', humanConfirm: 'before:1',
    plan: { steps: [{ catalog: 'produce', id: 'draft', instructions: draft }, { catalog: 'critique', id: 'review', gate: { human_confirm: { unconditional: true } }, instructions: review }] },
  } as never);
  const seen: string[] = [];
  let edited = false;
  const gateLog: unknown[] = [];
  let view = await adapter.runView(runId);
  for (let i = 0; i < 60; i++) {
    view = await adapter.runView(runId);
    const st = view?.session.status ?? 'none';
    if (seen.at(-1) !== st) seen.push(st);
    if (st === 'completed' || st === 'cancelled' || st === 'failed') break;
    if (st === 'awaiting_human') {
      const edit = !edited;
      edited = true;
      const tp = (view?.session as unknown as { team_plan?: { pending?: { rev?: number; steps?: { steps?: Array<Record<string, unknown>> } }; accepted?: unknown } }).team_plan;
      if (edit) gateLog.push({ gate: 'first', team_plan_keys: Object.keys(tp ?? {}), pending: JSON.stringify(tp?.pending ?? null).slice(0, 600), units: view?.units.map((u) => [u.id, u.status, u.gate]) });
      const held = tp?.pending?.steps?.steps ?? [];
      const steps = held.length > 0
        ? held.filter((x) => x['added_by'] !== 'floor').map((x) => (x['id'] === 'draft' ? { ...x, catalog: 'understand' } : x)).map((x) => { const rest = { ...x }; delete rest['added_by']; delete rest['floor_reason']; return rest; })
        : [{ catalog: 'produce', id: 'draft', instructions: `${draft}\n\nAlso add an epic for billing.` }, { catalog: 'critique', id: 'review', gate: { human_confirm: { unconditional: true } }, instructions: review }];
      const plan = { steps };
      await (edit ? adapter.confirmGate(runId, true, undefined, undefined, undefined, plan as never) : adapter.confirmGate(runId, true)).catch((e: unknown) => seen.push(`confirm-err:${String(e).slice(0, 160)}`));
      seen.push(edit ? 'edited' : 'confirmed');
      const after = await adapter.runView(runId);
      gateLog.push({ after: edit ? 'edit' : 'confirm', status: after?.session.status, rev: (after?.session as unknown as { team_plan?: { rev?: number } }).team_plan?.rev });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const record = { gateLog, projectId: PID, draft, review, statuses: seen, view, draftOutput: await adapter.workOutput(`${runId}:draft`) };
  // One line, so the CI log carries the whole view.
  console.log(`PROBE-1929-RECAT ${Buffer.from(JSON.stringify(record)).toString('base64')}`);
  adapter.close();
  removeScratch(dir);
}

it('probe: compose edited at its plan gate (core#1929)', { timeout: 120_000 }, probeEdit);
it('probe: compose re-catalogued at its plan gate (core#1929)', { timeout: 120_000 }, probeRecat);
