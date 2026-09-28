/**
 * "Discovered, not managed" (DES-MCP-TOOLS-001 §7, §8 `GET /mcp/servers`): the MCP servers the
 * CLIs on this machine are configured with, by NAME only.
 *
 * - Read-only. Each CLI's own config file is parsed and only the server names leave this module:
 *   never a command, URL, header or env value, because those are where a pasted token lives.
 * - Two origins. `operator`: the CLI's default home under the operator's home dir. `worker`: the
 *   seat's own home under the worker home (`<worker home>/<seat>`, the layout of wicked-apps-core
 *   `seat_config_for`). A worker-home server is invariant I1's finding: no wicked-handed native MCP
 *   server may sit in a worker home, so studio lists these in red.
 * - A file that is absent or does not parse contributes nothing; discovery never fails a request.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpDiscoveredServer } from '../core/types.js';

type Parser = (text: string) => string[];

/** Keys of a JSON object at `path`, or `[]`. */
function jsonKeys(...path: string[]): Parser {
  return (text) => {
    let node: unknown = JSON.parse(text);
    for (const key of path) {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
      node = (node as Record<string, unknown>)[key];
    }
    return node !== null && typeof node === 'object' && !Array.isArray(node) ? Object.keys(node) : [];
  };
}

/** `[mcp_servers.<id>]` table headers in a codex `config.toml` (bare or quoted ids; sub-tables folded). */
export function codexServerNames(text: string): string[] {
  const names = new Set<string>();
  const re = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) names.add(m[1] ?? m[2] ?? m[3] ?? '');
  names.delete('');
  return [...names];
}

interface Source {
  cli: string;
  /** Path relative to the operator's home dir. */
  operator: string;
  /** Path relative to the worker home. */
  worker: string;
  parse: Parser;
}

const SOURCES: ReadonlyArray<Source> = [
  { cli: 'claude', operator: '.claude.json', worker: 'claude/.claude.json', parse: jsonKeys('mcpServers') },
  { cli: 'codex', operator: '.codex/config.toml', worker: 'codex/config.toml', parse: codexServerNames },
  { cli: 'copilot', operator: '.copilot/mcp-config.json', worker: 'copilot/mcp-config.json', parse: jsonKeys('mcpServers') },
  { cli: 'opencode', operator: '.config/opencode/opencode.json', worker: 'opencode/config/opencode/opencode.json', parse: jsonKeys('mcp') },
  { cli: 'agy', operator: '.gemini/config/mcp_config.json', worker: 'agy/.gemini/config/mcp_config.json', parse: jsonKeys('mcpServers') },
];

export interface DiscoveryRoots {
  /** The operator's home dir. */
  home: string;
  /** The worker home (`WICKED_WORKER_HOME`); `null` = none configured. */
  workerHome: string | null;
}

function namesIn(file: string, parse: Parser): string[] {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Every server name configured in a CLI home; `managed` is set by the caller against the registry. */
export function discoverMcpServers(roots: DiscoveryRoots, managed: ReadonlySet<string>): McpDiscoveredServer[] {
  const out: McpDiscoveredServer[] = [];
  for (const src of SOURCES) {
    for (const name of namesIn(join(roots.home, src.operator), src.parse)) {
      out.push({ name, cli: src.cli, origin: 'operator', source: `~/${src.operator}`, managed: managed.has(name) });
    }
    if (roots.workerHome !== null) {
      for (const name of namesIn(join(roots.workerHome, src.worker), src.parse)) {
        out.push({ name, cli: src.cli, origin: 'worker', source: `<worker home>/${src.worker}`, managed: managed.has(name) });
      }
    }
  }
  return out;
}
