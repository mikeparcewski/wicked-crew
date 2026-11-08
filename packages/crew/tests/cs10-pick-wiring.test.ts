// DES-CATALOG-002 CS10: the daemon's wiring of the one pick store. The enforcement itself is tested with real objects
// (cs10-pick-{broker,knowledge,web}.test.ts); a full daemon cannot bind a unit token without a linked engine, so this
// file pins the wiring those tests cannot reach: ONE RunSourcePicks instance (launch's `set` and the broker's `get`
// read one in-memory map; two instances would leave the broker blind to every new pick, i.e. fail open), handed to
// the broker, the estate relay, the /mcp/tools route and the reshape launcher. Removing any of them fails here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api', file), 'utf8');
/** The text of the call that starts at `head` (balanced parentheses). */
function callAt(text: string, head: string): string {
  const start = text.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start + head.indexOf('('); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unbalanced call at ${head}`);
}

describe('CS10 wiring: one pick store reaches every enforcement point', () => {
  const server = src('server.ts');
  const routes = src('routes.ts');

  it('the daemon builds exactly one pick store and hands it to launch (runtime)', () => {
    expect(server.match(/new RunSourcePicks\(/g)).toHaveLength(1);
    expect(server).toMatch(/const runSourcePicks = new RunSourcePicks\(/);
    expect(server).toMatch(/^\s+runSourcePicks,$/m);
  });

  it('the broker and its estate relay read that store, the relay with the source owner names', () => {
    const broker = callAt(server, 'new McpBroker(');
    const relay = callAt(broker, 'new EstateRelay(');
    // The broker's own deps, without its relay's (which carry the store too).
    expect(broker.replace(relay, '')).toMatch(/\bpicks: runSourcePicks,/);
    expect(relay).toMatch(/\bpicks: runSourcePicks,/);
    expect(relay).toMatch(/\bsourceNames: sourceOwnerNames,/);
    // The owner names cover PM entries and their trackers, not only SQL sources.
    expect(server).toMatch(/for \(const e of await dataGate\.pm\.entries\(\)\)/);
  });

  it('the unit tool-list route and the reshape launcher read the launch store', () => {
    expect(callAt(routes, 'registerMcpRoutes(app, {')).toMatch(/\{ picks: runtime\.runSourcePicks \}/);
    expect(routes).toMatch(/jobInputsOfProposal\(p, runtime\.runSourcePicks !== undefined \? \(runId\) => runtime\.runSourcePicks!\.get\(runId\)/);
  });
});
