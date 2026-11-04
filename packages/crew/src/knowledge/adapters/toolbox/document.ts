/**
 * The Toolbox document crew writes for one source (DES-KNOWLEDGE-DATA-001 §5.1, §7.2, §7.5, §7.6).
 *
 * - **Spawn-time deployment policy.** The stored source document passes the registry's deployment policy again
 *   (`checkSourceDocument`, §5.1: enforced at preview, save, spawn and publish), then this file's own ALLOWLIST:
 *   `kind`, `name`, `type`, `host`, `port`, `user`, `password`, `database`. Everything else is refused here even if
 *   a save let it through: `connectionString` (bypasses the address check), `queryExecMode` (`simple_protocol`
 *   would run several statements), `queryParams` (crew writes them), `sqlCommenter`, any path. B2 runs
 *   `type: postgres` only on this runtime.
 * - **Secrets** appear only as the double-quoted placeholder `"${WICKED_SRC_<n>}"`. At spawn the value goes
 *   into that one process's environment as the YAML-escaped BODY of a double-quoted scalar: Toolbox
 *   substitutes `${VAR}` as text before it parses YAML (`cmd/internal/config.go`, single pass, never inside a
 *   comment), so the YAML parser hands the driver the original bytes, quotes and newlines included. No file
 *   holds a value.
 * - **Crew-written Postgres startup parameters** (§7.2), as pgx runtime parameters in `queryParams`:
 *   `default_transaction_read_only=on`, `search_path=pg_catalog,pg_temp`, `standard_conforming_strings=on`,
 *   `statement_timeout` (the gate's 10 s), `idle_in_transaction_session_timeout`, an `application_name` that
 *   names the entry (the reservation's check finds its sessions by it), and `sslmode` from the TLS choice.
 * - **Host mode** (§7.5: no container runtime): Toolbox dials for itself, so the host must be an IP literal
 *   the dialer admits under the entry's confirmed ranges (loopback included). A hostname is refused, with the
 *   remedy "start the container runtime".
 * - Tools: `execute_sql` and `list_tables` only, under crew's names. Nothing else is served.
 */

import { isIP } from 'node:net';

import { type AddressPolicy, DialRefusedError, plaintextAllowed, resolveTarget } from '../../../sources/dialer.js';
import { checkSourceDocument, DeploymentPolicyError } from '../../registry/policy.js';

/** The fields a stored Postgres source document may carry. */
const ALLOWED_FIELDS = new Set(['kind', 'name', 'type', 'host', 'port', 'user', 'password', 'database']);
const PLACEHOLDER = /^\$\{(WICKED_SRC_[0-9]{1,3})\}$/;

/** A source document the spawn policy refused; `code` is crew's, the words are crew's. */
export class ToolboxDocumentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'ToolboxDocumentError';
  }
}

export interface ToolboxDocumentInput {
  /** The registry id (§5.1). */
  id: string;
  /** The source document as the registry stores it (Toolbox's own form). */
  document: Record<string, unknown>;
  address: AddressPolicy;
  /** The person's TLS choice; `disable` only where the dialer allows plaintext for the address. */
  tls: 'verify-full' | 'disable';
  /** The person's CA (PEM) for verify-full; `null` = the system roots. Written beside the document, never a path they name. */
  ca?: string | null;
  /** The gate's deadline, written as `statement_timeout`. */
  statementTimeoutMs: number;
  /** TESTS ONLY (the reservation's simulation, §19 B2): write no `statement_timeout`. */
  omitStatementTimeout?: boolean;
}

export interface ToolboxDocument {
  /** The whole `tools.yaml` text: placeholders only. */
  yaml: string;
  /** The placeholder variable the password names (`WICKED_SRC_<n>`), or `null` for a login without one. */
  secretVar: string | null;
  /** The `application_name` crew wrote: how the reservation's check finds this source's sessions. */
  applicationName: string;
  /** Whether a source-side deadline was written (else: concurrency 1 and the reservation after a kill). */
  sourceDeadline: boolean;
  /** The checked address (an IP literal). */
  host: string;
  port: number;
  /** The CA to write as `ca.pem` in the run directory (the document names it relatively), or `null`. */
  caPem: string | null;
}

/** A YAML double-quoted scalar's BODY for `value`: the parser turns it back into exactly `value`. */
export function yamlQuotedBody(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += `\\u${cp.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return out;
}

/** A whole YAML double-quoted scalar. */
const q = (v: string): string => `"${yamlQuotedBody(v)}"`;

/** The source's sessions are named by this (no secret, no host: the id's first 12 hex). */
export function applicationNameOf(id: string): string {
  return `wicked-crew-tb-${id.replace(/[^0-9a-f]/gi, '').slice(0, 12).toLowerCase()}`;
}

/** Check the stored document against the spawn policy and write crew's `tools.yaml`. */
export async function toolboxDocument(input: ToolboxDocumentInput): Promise<ToolboxDocument> {
  const d = input.document;
  try {
    checkSourceDocument(d, { runtime: 'toolbox' });
  } catch (err) {
    if (err instanceof DeploymentPolicyError) throw new ToolboxDocumentError(err.code === 'refused_field' || err.code === 'crew_written_field' || err.code === 'unknown_field' ? 'field_refused' : err.code === 'unsupported_type' ? 'type_unsupported' : err.code === 'secret_literal' ? 'secret_inline' : 'field_invalid', `the source document is refused at spawn: ${err.message}`, 'save the source again');
    throw err;
  }
  for (const k of Object.keys(d)) {
    if (!ALLOWED_FIELDS.has(k)) {
      throw new ToolboxDocumentError('field_refused', `the source document's field "${k}" is refused on the Toolbox runtime (crew writes its own connection parameters)`, 'remove the field and save the source again');
    }
  }
  if (d['kind'] !== undefined && d['kind'] !== 'source') throw new ToolboxDocumentError('field_refused', 'the source document is not a `kind: source`', 'save the source again');
  if (d['type'] !== 'postgres') throw new ToolboxDocumentError('type_unsupported', `the Toolbox runtime serves \`type: postgres\` in this release, not ${JSON.stringify(d['type'])}`, 'use the native runtime for this source');
  const str = (k: string): string => {
    const v = d[k];
    if (typeof v !== 'string' || v === '' || v.length > 256) throw new ToolboxDocumentError('field_invalid', `the source document's "${k}" must be a non-empty string`, 'save the source again');
    // A placeholder anywhere but the password would put a value somewhere crew does not scrub as one.
    if (k !== 'password' && v.includes('${')) throw new ToolboxDocumentError('field_invalid', `the source document's "${k}" holds a placeholder; only the password may`, 'save the source again');
    return v;
  };
  const host = str('host');
  const user = str('user');
  const database = str('database');
  const portRaw = d['port'];
  const port = typeof portRaw === 'number' ? portRaw : typeof portRaw === 'string' && /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ToolboxDocumentError('field_invalid', "the source document's port is not a port number", 'save the source again');
  let secretVar: string | null = null;
  if (d['password'] !== undefined) {
    const m = typeof d['password'] === 'string' ? PLACEHOLDER.exec(d['password']) : null;
    if (m === null) throw new ToolboxDocumentError('secret_inline', "the source document's password is not a secret placeholder (\"${WICKED_SRC_<n>}\"): a value is never stored", 'save the source again with its password as a secret');
    secretVar = m[1] as string;
  }

  // Host mode: an IP literal the dialer admits (loopback included, when the person confirmed its range).
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 0) {
    throw new ToolboxDocumentError('host_mode_hostname', `${host} is a host name: on the host floor an adapter that resolves names for itself is refused (it could be rebound to another address)`, 'start the container runtime, or give the source an IP address');
  }
  let cls: Awaited<ReturnType<typeof resolveTarget>>['cls'];
  try {
    cls = (await resolveTarget(bare, input.address)).cls;
  } catch (err) {
    if (err instanceof DialRefusedError) throw new ToolboxDocumentError(err.code, err.message, 'confirm a range covering the address on the source sheet');
    throw err;
  }
  if (input.tls === 'disable' && !plaintextAllowed(cls, input.address)) {
    throw new ToolboxDocumentError('plaintext_refused', `a connection without TLS to ${bare} is refused: use TLS (verify-full), or confirm this ${cls} range as plaintext`, 'turn TLS on for the source');
  }

  const applicationName = applicationNameOf(input.id);
  const sourceDeadline = input.omitStatementTimeout !== true;
  const params: Array<[string, string]> = [
    ['application_name', applicationName],
    ['default_transaction_read_only', 'on'],
    ['search_path', 'pg_catalog,pg_temp'],
    ['standard_conforming_strings', 'on'],
    ...(sourceDeadline ? ([['statement_timeout', String(Math.max(1, Math.floor(input.statementTimeoutMs)))]] as Array<[string, string]>) : []),
    ['idle_in_transaction_session_timeout', String(Math.max(1, Math.floor(input.statementTimeoutMs)) + 5_000)],
    ['sslmode', input.tls === 'disable' ? 'disable' : 'verify-full'],
    // A CA the person gave: crew writes it beside the document (the process runs in its run directory).
    ...(input.tls !== 'disable' && input.ca != null && input.ca !== '' ? ([['sslrootcert', 'ca.pem']] as Array<[string, string]>) : []),
  ];
  const lines = [
    'kind: source',
    'name: src',
    'type: postgres',
    `host: ${q(bare)}`,
    `port: ${q(String(port))}`,
    `user: ${q(user)}`,
    `password: "${secretVar === null ? '' : `\${${secretVar}}`}"`,
    `database: ${q(database)}`,
    'connectTimeout: 10',
    'queryParams:',
    ...params.map(([k, v]) => `  ${k}: ${q(v)}`),
    '---',
    'kind: tool',
    'name: execute_sql',
    'type: postgres-execute-sql',
    'source: src',
    'description: Run one SQL statement.',
    '---',
    'kind: tool',
    'name: list_tables',
    'type: postgres-list-tables',
    'source: src',
    'description: List tables with columns, constraints and indexes.',
    '',
  ];
  return { yaml: lines.join('\n'), secretVar, applicationName, sourceDeadline, host: bare, port, caPem: input.tls !== 'disable' && input.ca != null && input.ca !== '' ? input.ca : null };
}
