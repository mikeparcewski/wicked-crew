/**
 * Run learnings' estate calls. A learning crew files is attributed to its SOURCE run the way a
 * seat's is: estate's `proposal.submit` stamps provenance from its own process env
 * (`WICKED_RUN_ID` / `WICKED_RUN_UNIT` / `WICKED_RUN_AGENT`), never from arguments. So each submit
 * spawns the daemon's estate server (its own memory store, write mode, as `/proposals` uses) with
 * those three set to the run and the agent that worded the learning.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { callEstateTool, estateMcpExe, resolveMemoryDb } from '../core/estate-mcp-client.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import type { ProposalRow, SubmitArgs } from './service.js';

/** The estate server's env for one attributed submit (exported for its test). */
export function learningSubmitEnv(runId: string, agent: string, base: NodeJS.ProcessEnv = childEnvWithBootEstateDb(process.env)): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) if (k.startsWith('WICKED_RUN_')) delete env[k];
  return {
    ...env,
    WICKED_MEMORY_DB: resolveMemoryDb(base).path,
    WICKED_RUN_ID: runId,
    // Not a unit's work: the run as a whole.
    WICKED_RUN_UNIT: '0',
    WICKED_RUN_AGENT: agent,
  };
}

export async function submitLearning(runId: string, agent: string, args: SubmitArgs): Promise<string | null> {
  const env = learningSubmitEnv(runId, agent, childEnvWithBootEstateDb(process.env));
  const db = env['WICKED_MEMORY_DB'];
  if (resolveMemoryDb(process.env).source !== 'explicit' && typeof db === 'string') {
    try {
      mkdirSync(dirname(db), { recursive: true });
    } catch {
      // The server reports a parent it cannot open.
    }
  }
  const res = (await callEstateTool('proposal.submit', args as unknown as Record<string, unknown>, {
    spawn: () =>
      nodeSpawn(estateMcpExe(), [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The daemon's boot-time estate db, never its exported governance store (crew#495).
        env: learningSubmitEnv(runId, agent, childEnvWithBootEstateDb(process.env)),
        windowsHide: true,
      }),
  })) as { id?: unknown } | null;
  return typeof res?.id === 'string' && res.id !== '' ? res.id : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `proposal.list` (every state), read loosely. */
export function proposalRows(raw: unknown): ProposalRow[] {
  const list = isRecord(raw) && Array.isArray(raw['proposals']) ? raw['proposals'] : [];
  return list.filter(isRecord).map((p) => ({
    id: String(p['id'] ?? ''),
    kind_type: String(p['kind_type'] ?? ''),
    state: String(p['state'] ?? ''),
    ...(typeof p['created_at'] === 'number' ? { created_at: p['created_at'] } : {}),
    payload: isRecord(p['payload']) ? p['payload'] : {},
    facets: isRecord(p['facets']) ? p['facets'] : {},
    provenance: isRecord(p['provenance']) ? p['provenance'] : {},
  }));
}

/** `memory.list` items' text. */
export function memoryContents(raw: unknown): string[] {
  const items = isRecord(raw) && Array.isArray(raw['items']) ? raw['items'] : [];
  return items.filter(isRecord).map((m) => m['content']).filter((c): c is string => typeof c === 'string');
}
