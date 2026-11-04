/**
 * (DES-KNOWLEDGE-DATA-001 §5.2, crew#1317) The audit trail as a non-human reader may see it.
 *
 * `GET /audit` is an observer read. The MCP, source and app-action lines carry connection data in their
 * `detail`: a saved server's secret reference (`authRef`), the confirmed address ranges, a REST server's
 * origin, base path, resolved address and its spec's servers, a test call's URL, a query's relations, an
 * action run's operation (`UPDATE support.tickets`) and its reason. A human actor
 * reads every line whole. Any other actor ({@link viewOf} `agent`) reads those lines with their `detail`
 * reduced to the keys allowed below, the way `GET /mcp/servers` answers it the agent-safe view. The trail
 * on disk is unchanged, and so is every in-process reader (`readAll`).
 *
 * An ALLOWLIST, per action: a key added to one of these lines later stays out of the agent view until it
 * is allowed here. An action of these families that is not listed keeps only {@link IDENTITY}.
 */

import type { Actor, AuditEntry } from '../core/types.js';
import { viewOf } from './auth.js';

/** The action families whose `detail` can hold a source's connection data. */
const FAMILIES: readonly string[] = ['mcp.', 'apps.source.', 'apps.action.', 'knowledge.source.'];

/** What any line of those families keeps: which server, source, tool, app or action it is about. */
const IDENTITY: readonly string[] = ['name', 'source', 'subject', 'subjects', 'app', 'action'];

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'mcp.server.saved': ['name', 'kind', 'tools', 'disabledWrites'],
  'mcp.server.address_confirmed': ['name', 'kind'],
  'mcp.server.egress_confirmed': ['name'],
  'mcp.server.enabled': ['name'],
  'mcp.server.disabled': ['name'],
  'mcp.server.removed': ['name'],
  'mcp.secret.set': ['name'],
  'mcp.tool.updated': ['subject', 'enabled', 'classOverride', 'disclosure'],
  'mcp.tool.write_granted': ['subject', 'class', 'via'],
  'mcp.tool.disclosure_reviewed': ['subject', 'disclosure', 'via'],
  'mcp.approval.granted': ['subject', 'rules'],
  'mcp.approval.revoked': ['subject', 'rules'],
  'mcp.approval.withdrawn': ['subjects', 'rules', 'why'],
  'mcp.approval.partial': ['subjects', 'rules'],
  'mcp.registry.restored': ['restored', 'generation', 'servers', 'disabled', 'queryReset', 'writesReset', 'withdrawnApprovals'],
  'apps.source.writes_allowed': ['source', 'refused', 'withdrawFailed', 'withdrawnStaleGrants'],
  'apps.source.writes_disallowed': ['source', 'withdrawnGrants', 'withdrawFailed'],
  'apps.source.test_call': ['source', 'ok', 'status', 'failed'],
  'apps.source.asked': ['source', 'seat', 'drafted', 'failed', 'check'],
  'apps.source.queried': ['source', 'ok', 'rows', 'truncated', 'ms', 'errorClass', 'sqlstate', 'refused', 'failed'],
  'apps.source.uploaded': ['source', 'kind', 'digest', 'bytes'],
  'apps.action.granted': ['app', 'action', 'kind', 'source', 'actionHash', 'contractHash', 'descriptorHash'],
  'apps.action.revoked': ['app', 'action'],
  'apps.action.ran': ['app', 'action', 'record', 'outcome', 'recovered', 'recordNotSaved', 'ms'],
};

/** The keys of `action`'s detail a non-human reader keeps; `null` = the line is not a source line (kept whole). */
export function agentAuditKeys(action: string): readonly string[] | null {
  if (Object.hasOwn(ALLOWED, action)) return ALLOWED[action]!;
  return FAMILIES.some((f) => action.startsWith(f)) ? IDENTITY : null;
}

/** One entry as `actor` may read it. */
export function auditEntryFor(actor: Actor | null | undefined, entry: AuditEntry): AuditEntry {
  if (viewOf(actor) === 'full' || entry.detail === undefined) return entry;
  const keys = agentAuditKeys(entry.action);
  if (keys === null) return entry;
  const detail: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(entry.detail, k)) detail[k] = entry.detail[k];
  return { ...entry, detail };
}

/** `GET /audit`'s entries as `actor` may read them. */
export function auditFor(actor: Actor | null | undefined, entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.map((e) => auditEntryFor(actor, e));
}
