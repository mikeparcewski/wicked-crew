// A stand-in for MCP Toolbox's `--stdio` server (DES-KNOWLEDGE-DATA-001 §6.3), for the supervisor's tests in CI
// (the real 155 MB binary runs only where WICKED_TOOLBOX_BIN is set). It substitutes `${VAR}` in its config as
// text before parsing YAML, as Toolbox does (cmd/internal/config.go), and answers newline-framed JSON-RPC.
// The SQL text picks a behaviour: HANG never answers, BIG answers a 2 MiB line, ERROR answers a source error that
// echoes a value, STDERR writes the decoded password to stderr. Never writes a file.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parseAllDocuments } from 'yaml';

const args = process.argv.slice(2);
const config = args[args.indexOf('--config') + 1];
if (!args.includes('--stdio') || config === undefined) {
  process.stderr.write('fake-toolbox: --stdio and --config are required\n');
  process.exit(2);
}
const raw = readFileSync(config, 'utf8').replace(/\$\{(\w+)(:([^}]*))?\}/g, (_m, name) => process.env[name] ?? '');
const docs = parseAllDocuments(raw).map((d) => d.toJS());
const source = docs.find((d) => d.kind === 'source');
const qp = source.queryParams ?? {};
const leaked = Object.keys(process.env).filter((k) => k.startsWith('PG') || k === 'WICKED_STATE_HOME' || k === 'GH_TOKEN');

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (o) => ({ type: 'text', text: JSON.stringify(o) });

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-toolbox', version: '0' } } });
  if (msg.method !== 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } });
  const name = msg.params?.name;
  const sql = String(msg.params?.arguments?.sql ?? '');
  const ok = (content) => send({ jsonrpc: '2.0', id: msg.id, result: { content } });
  if (name === 'whoami') return ok([text({ pw_sha: createHash('sha256').update(String(source.password)).digest('hex'), leaked, application_name: qp.application_name ?? null })]);
  if (name === 'list_tables') {
    return ok([
      text({
        schema_name: 's',
        object_name: 't',
        object_details: { schema_name: 's', object_name: 't', object_type: 'TABLE', columns: [{ column_name: 'a', data_type: 'integer', ordinal_position: 1, is_not_nullable: true }, { column_name: 'b', data_type: 'text', ordinal_position: 2, is_not_nullable: false }], constraints: [{ constraint_type: 'PRIMARY KEY', constraint_columns: ['a'], constraint_name: 't_pkey' }] },
      }),
    ]);
  }
  if (sql.startsWith("SELECT current_setting('default_transaction_read_only')")) {
    const ro = source.database === 'unverified' ? 'off' : qp.default_transaction_read_only;
    return ok([text({ ro, tro: ro, sp: String(qp.search_path ?? '').replace(',', ', '), scs: qp.standard_conforming_strings, st: qp.statement_timeout === undefined ? '0' : `${qp.statement_timeout}ms` })]);
  }
  // The reservation's check: the test leaves `remote-running` in the process's HOME (its run dir) while the remote work "runs".
  if (sql.includes('pg_stat_activity')) return ok([text({ n: existsSync(join(process.env.HOME ?? '.', 'remote-running')) ? 1 : 0 })]);
  if (sql.includes('pg_inherits')) return ok([]);
  if (sql.includes('HANG')) return;
  if (sql.includes('BIG')) return ok([text({ big: 'x'.repeat(2 * 1024 * 1024) })]);
  if (sql.includes('ERROR')) return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `error processing request: unable to execute query: ERROR: invalid input syntax for type integer: "${source.password}" (SQLSTATE 22P02)` }], isError: true } });
  if (sql.includes('STDERR')) process.stderr.write(`fake-toolbox: connecting with ${source.password}\n`);
  return ok([text({ a: 1, b: 'x' }), text({ a: 2, b: 'y' })]);
});
