// CI (job sources-db): fetch the pinned MCP Toolbox v1.15.0 through crew's own ToolboxBinary, which verifies its
// sha256 before it is made executable, into <dir>/adapters/toolbox/<version>/<platform>/, and print its path.
// Usage: tsx scripts/fetch-toolbox.ts <dir>
import { ToolboxBinary } from '../src/knowledge/adapters/toolbox/binary.js';

const dir = process.argv[2];
if (dir === undefined || dir === '') throw new Error('usage: tsx scripts/fetch-toolbox.ts <dir>');
process.stdout.write(`${await new ToolboxBinary({ home: dir }).ensure()}\n`);
