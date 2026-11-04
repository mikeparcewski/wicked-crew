/**
 * The deployment policy for a database source's Toolbox document (DES-KNOWLEDGE-DATA-001 §5.1).
 *
 * A database source stores MCP Toolbox for Databases' OWN source document (its `tools.yaml` model) as the
 * source of truth. Toolbox publishes no JSON Schema, so the schema here is derived by hand from Toolbox's
 * `Config` struct for the PINNED release, and re-derived (and re-reviewed) when the pin moves. On top of the
 * schema, the policy says, per field:
 *
 * - **refused**: the field bypasses the address check, names a path on the daemon's host, needs host
 *   libraries, or tunes the driver. A document carrying one is refused.
 * - **crew-written**: only crew writes it, at spawn, from the entry (the TLS choice, the session's startup
 *   parameters, timeouts, the source's name). A document carrying one is refused; a stored document never
 *   holds one.
 * - **required**: what the source cannot run without.
 *
 * Secrets appear only as the double-quoted placeholder `"${WICKED_SRC_<n>}"`. Toolbox expands `${VAR}` and
 * `${VAR:default}` across the whole document before it parses it, so `${` anywhere else is refused: it would
 * read the adapter's environment.
 *
 * The check runs at the preview, and inside every registry write for each document that is new or changed (or
 * judged for another runtime), so no path stores one it refuses; a restore checks every document of the
 * generation before anything changes. The Toolbox runtime runs it again at spawn, and publish will (next briefs).
 * Never only in the UI.
 */

/** The Toolbox release the schema below was derived from (`internal/sources/postgres/postgres.go`). */
export const TOOLBOX_RELEASE = 'v1.15.0';

/** The placeholder a source's first secret takes; it names the entry's `auth.ref`. */
export const SECRET_PLACEHOLDER = 'WICKED_SRC_1';
export const SECRET_PLACEHOLDER_VALUE = '${WICKED_SRC_1}';

/** Toolbox source types crew has a reviewed deployment policy for. */
export type ToolboxSourceType = 'postgres';

/** A database source as Toolbox models it: `kind: source`, its `type`, and that type's fields. */
export interface ToolboxSourceDocument {
  kind: 'source';
  type: ToolboxSourceType;
  host: string;
  /** Toolbox's `Config` takes the port as a string. */
  port: string;
  database: string;
  user: string;
  /** Exactly {@link SECRET_PLACEHOLDER_VALUE}; absent for a login with no password. */
  password?: string;
}

export interface DeploymentPolicy {
  type: ToolboxSourceType;
  /** Bumped when this policy changes; part of a version-2 descriptor. */
  version: number;
  /** Every field Toolbox's `Config` for this type has (plus `kind`). */
  fields: readonly string[];
  required: readonly string[];
  /** Refused fields, each with why. Unknown fields are refused too. */
  refused: Readonly<Record<string, string>>;
  /** Fields only crew writes, at spawn, each with what crew writes there. */
  crewWritten: Readonly<Record<string, string>>;
}

/**
 * Postgres (Toolbox v1.15.0 `postgres.Config`: name, type, host, port, user, password, database, queryParams,
 * queryExecMode, sqlCommenter, connectTimeout).
 */
export const POSTGRES_POLICY: DeploymentPolicy = Object.freeze({
  type: 'postgres',
  version: 1,
  fields: Object.freeze(['kind', 'name', 'type', 'host', 'port', 'user', 'password', 'database', 'queryParams', 'queryExecMode', 'sqlCommenter', 'connectTimeout']),
  required: Object.freeze(['kind', 'type', 'host', 'port', 'database', 'user']),
  refused: Object.freeze({
    connectionString: 'a connection string names its own hosts, so it would bypass the address check',
    queryExecMode: 'it tunes the driver',
    sqlCommenter: 'it tunes the driver',
  }),
  crewWritten: Object.freeze({
    name: "crew writes the entry's own name",
    queryParams: 'crew writes the TLS settings from the TLS choice and the session startup parameters (read-only, timeouts, search path); they can name paths on the host and switch read-only off',
    connectTimeout: 'crew writes the session timeouts',
  }),
}) as DeploymentPolicy;

const POLICIES: Readonly<Record<ToolboxSourceType, DeploymentPolicy>> = Object.freeze({ postgres: POSTGRES_POLICY });

/** The policy for a Toolbox source type; `null` = no reviewed policy (the type is refused). */
export function policyFor(type: string): DeploymentPolicy | null {
  return Object.prototype.hasOwnProperty.call(POLICIES, type) ? POLICIES[type as ToolboxSourceType] : null;
}

/** `postgres/1@toolbox-v1.15.0`: which policy and which Toolbox release a document was checked under. */
export function policyVersionOf(type: ToolboxSourceType): string {
  return `${type}/${POLICIES[type].version}@toolbox-${TOOLBOX_RELEASE}`;
}

export type DeploymentPolicyCode = 'unsupported_type' | 'refused_field' | 'crew_written_field' | 'unknown_field' | 'missing_field' | 'bad_field' | 'secret_literal' | 'interpolation';

export class DeploymentPolicyError extends Error {
  constructor(
    readonly code: DeploymentPolicyCode,
    readonly field: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** A host name or an IP literal: no comma (pgx reads several hosts), slash (a socket path), `@`, space or control. */
const HOST_RE = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?)*\.?|\[?(?=[0-9A-Fa-f.]*:)[0-9A-Fa-f:.]{2,45}\]?)$/;
const PORT_RE = /^[1-9][0-9]{0,4}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Check a Toolbox source document against its type's deployment policy, and answer it in its stored form.
 * The same check serves what a person sent and what the registry holds: both refuse crew-written fields,
 * which crew writes at spawn into the process's copy only. Throws {@link DeploymentPolicyError}.
 */
export function checkSourceDocument(doc: unknown, opts: { runtime: 'native' | 'toolbox' }): ToolboxSourceDocument {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new DeploymentPolicyError('bad_field', null, 'the Toolbox document is an object');
  const d = doc as Record<string, unknown>;
  if (d['kind'] !== 'source') throw new DeploymentPolicyError('bad_field', 'kind', 'a source document has kind "source"');
  const policy = typeof d['type'] === 'string' ? policyFor(d['type']) : null;
  if (policy === null) {
    throw new DeploymentPolicyError('unsupported_type', 'type', `crew has no reviewed deployment policy for a Toolbox source of type ${JSON.stringify(d['type'] ?? null)} (Toolbox ${TOOLBOX_RELEASE}); supported: ${Object.keys(POLICIES).join(', ')}`);
  }
  for (const key of Object.keys(d)) {
    const refused = policy.refused[key];
    if (refused !== undefined) throw new DeploymentPolicyError('refused_field', key, `${key} is refused for a ${policy.type} source: ${refused}`);
    const crew = policy.crewWritten[key];
    if (crew !== undefined) throw new DeploymentPolicyError('crew_written_field', key, `${key} is written by crew, not by the document: ${crew}`);
    if (!policy.fields.includes(key)) throw new DeploymentPolicyError('unknown_field', key, `${key} is not a field of Toolbox ${TOOLBOX_RELEASE}'s ${policy.type} source`);
  }
  for (const key of policy.required) {
    if (d[key] === undefined || d[key] === null || d[key] === '') throw new DeploymentPolicyError('missing_field', key, `a ${policy.type} source needs ${key}`);
  }
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== 'string' && !(key === 'port' && typeof value === 'number')) throw new DeploymentPolicyError('bad_field', key, `${key} is a string`);
    const text = String(value);
    if (CONTROL_RE.test(text)) throw new DeploymentPolicyError('bad_field', key, `${key} holds a control character`);
    if (key === 'password') continue;
    if (text.includes('${')) throw new DeploymentPolicyError('interpolation', key, `${key} holds "\${": Toolbox would expand it from the adapter's environment; only the password may reference a secret`);
  }
  const password = d['password'];
  if (password !== undefined && password !== SECRET_PLACEHOLDER_VALUE) {
    throw new DeploymentPolicyError('secret_literal', 'password', `the password is a secret reference, never a value: write exactly "${SECRET_PLACEHOLDER_VALUE}" and give the secret through auth.ref`);
  }
  if (password === undefined && opts.runtime === 'toolbox') throw new DeploymentPolicyError('missing_field', 'password', `the Toolbox runtime needs a password: write "${SECRET_PLACEHOLDER_VALUE}"`);
  const host = String(d['host']);
  if (host.length > 253 || !HOST_RE.test(host)) throw new DeploymentPolicyError('bad_field', 'host', 'host is one host name or IP address (no list, path, user or port)');
  const port = String(d['port']);
  if (!PORT_RE.test(port) || Number(port) > 65_535) throw new DeploymentPolicyError('bad_field', 'port', 'port is 1-65535');
  for (const key of ['database', 'user'] as const) {
    const v = String(d[key]);
    if (v.length > 128) throw new DeploymentPolicyError('bad_field', key, `${key} is at most 128 characters`);
  }
  return {
    kind: 'source',
    type: policy.type,
    host,
    port,
    database: String(d['database']),
    user: String(d['user']),
    ...(password !== undefined ? { password: SECRET_PLACEHOLDER_VALUE } : {}),
  };
}
