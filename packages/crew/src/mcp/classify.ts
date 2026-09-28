/**
 * MCP tool identity and class (DES-MCP-TOOLS-001 §4.2, §5).
 *
 * - The SUBJECT is the policy token a tool is judged by: `mcp:<server>/<tool>`. A server name
 *   never contains `/`, so the first `/` after `mcp:` always splits it.
 * - The CLASS comes from the tool's own `tools/list` annotations, never from a carrier (F-2):
 *   an operator override wins; else `read` when `readOnlyHint === true`; else `destructive` when
 *   `destructiveHint !== false` (the MCP spec default); else `write`. A tool with NO annotations
 *   is `write` (D-4).
 * - The SCHEMA HASH covers everything a policy or an operator approved: description, input and
 *   output schema, and annotations. Any change sends the tool back to unregistered (D-5) until it
 *   is previewed and saved again.
 */

import { createHash } from 'node:crypto';

import type { McpToolAnnotations, McpToolClass } from '../core/types.js';

/** A server name: a lowercase token that is safe inside `mcp:<server>/<tool>` and a keychain account. */
export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function mcpSubject(server: string, tool: string): string {
  return `mcp:${server}/${tool}`;
}

/** `mcp:<server>/<tool>` → its parts, or `null` for anything else. */
export function parseMcpSubject(subject: string): { server: string; tool: string } | null {
  if (!subject.startsWith('mcp:')) return null;
  const rest = subject.slice(4);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  const server = rest.slice(0, slash);
  if (!MCP_SERVER_NAME_RE.test(server)) return null;
  return { server, tool: rest.slice(slash + 1) };
}

/** The class `tools/list` annotations imply (§4.2). `null` annotations = none declared = `write` (D-4). */
export function deriveToolClass(annotations: McpToolAnnotations | null): McpToolClass {
  if (annotations === null) return 'write';
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.destructiveHint !== false) return 'destructive';
  return 'write';
}

/** The class a policy sees: the operator's override when set, else the derived one. */
export function effectiveToolClass(derived: McpToolClass, override: McpToolClass | null): McpToolClass {
  return override ?? derived;
}

/** JSON with object keys sorted at every depth, so a hash never depends on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The fields of a listed tool the schema hash covers. */
export interface HashedToolShape {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  annotations: McpToolAnnotations | null;
}

export function toolSchemaHash(tool: HashedToolShape): string {
  return sha256Hex(
    canonicalJson({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }),
  );
}
