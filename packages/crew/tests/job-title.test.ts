// AgentSession.title (api-types 0.112.0): the daemon's short job title, derived from the run's problem.
// Cases are the real problems on the operator's daemon (DES-frontdoor §4 requirement 1).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { JOB_TITLE_MAX, jobTitle } from '../src/api/job-title.js';
import type { SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

describe('jobTitle', () => {
  it.each([
    // An attached studio context pack is never part of the title.
    ['hey\n\n---\n[studio context pack — assembled 2026-10-11T23:54:07.374Z]\nwhere: Home (/)\nruns …', 'Hey'],
    ['Onboard repository: wicked-crew', 'Set up wicked-crew'],
    ['Capture learnings from wicked-crew', 'Capture learnings from wicked-crew'],
    // An aside past the budget is cut; an identifier keeps its spelling.
    ['capture-learnings never lands a proposal when the estate MCP is policy-blocked — surface GroundingUnavailable and retry', 'capture-learnings never lands a proposal'],
    ['repo-learn / search ladder: ground through the estate stdio shim (--readonly) in governed mode; never the raw', 'repo-learn / search ladder'],
    ['Recon the Tests feature in wicked-studio, meaning the Test rail section at /testing/campaigns with CampaignsPage', 'Recon the Tests feature in wicked-studio'],
    // A one-word label stays with its headline.
    ['Recon: survey the target and propose a test plan — the scenarios, their dependencies, and which are deterministic', 'Recon: survey the target and propose a test plan'],
    ['Governance: allowlist the estate stdio shim (--readonly) and read-only wicked-estate subcommands in governed units', 'Governance: allowlist the estate stdio shim'],
    // No aside to cut at: a word boundary and an ellipsis.
    ['Add a policy around going with managed cloud native services as the first option for designing new application', 'Add a policy around going with managed cloud native services…'],
    ['Fix the login bug. Then add a test.', 'Fix the login bug'],
    ['# Plan the release\n\nDetails follow', 'Plan the release'],
    ['   ', 'Untitled job'],
  ])('%j → %j', (problem, title) => {
    expect(jobTitle(problem)).toBe(title);
  });

  it('cuts the engine step scaffold', () => {
    expect(jobTitle('review the diff ||| PHASE SCOPE: build only')).toBe('Review the diff');
  });

  it('titles a chat ask run by what the conversation is about', () => {
    const statement = '# Chat scope\nThis directory is the scratch root of wicked-crew chat abc.\n\n## Repositories\n- **wicked-crew** (x)\n- **wicked-core** (y)\n';
    expect(jobTitle(statement)).toBe('A conversation about wicked-crew and wicked-core');
  });

  it('never exceeds the budget', () => {
    const long = 'word '.repeat(80);
    const t = jobTitle(long);
    expect(t.length).toBeLessThanOrEqual(JOB_TITLE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
    expect(jobTitle('x'.repeat(200)).length).toBeLessThanOrEqual(JOB_TITLE_MAX);
  });

  it('tolerates a missing problem', () => {
    expect(jobTitle(undefined)).toBe('Untitled job');
    expect(jobTitle(null)).toBe('Untitled job');
  });
});

describe('GET /api/v1/runs serves the title', () => {
  let scratch: string;
  let app: FastifyInstance;
  const RUN: SessionView = {
    session: { id: 'run-t', status: 'completed', problem: 'Fix the login bug. Then add a test.', units: [] } as unknown as SessionView['session'],
    units: [],
  };

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-job-title-'));
    const adapter = {
      stub: true,
      projectsSupported: () => false,
      getSettings: async () => ({}),
      onLaunch: (): (() => void) => () => undefined,
      onEvent: () => () => {},
      sessions: async () => ['run-t'],
      sessionsDetail: async () => [structuredClone(RUN)],
      getSession: async () => structuredClone(RUN),
    } as unknown as CoreAdapter;
    app = await createServer(adapter, {
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      studioRoot: join(scratch, 'no-studio'),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    removeScratch(scratch);
  });

  it('on the list, beside the untouched problem', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionView[] | { runs: SessionView[] };
    const runs = Array.isArray(body) ? body : body.runs;
    expect(runs[0]?.session.title).toBe('Fix the login bug');
    expect(runs[0]?.session.problem).toBe('Fix the login bug. Then add a test.');
  });
});
