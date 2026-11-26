// runner-files.mjs: every file crew's SQLite runner loads, derived from the runner itself (crew#1956).
//
// The image runs `runners/sqlite-runner.mjs` as a child process, and it imports its siblings (upload-parse.mjs
// since crew#1721). build.mjs copies exactly this set and records it in dist/runners/files.json, which crew's
// appsServerArtifact() requires file by file. A relative import that names no file here throws, so a runner
// that would fail with ERR_MODULE_NOT_FOUND in the container fails the build instead.
//
// Cross-platform: pure Node fs, no shell.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Static `import … from './x'`, `export … from './x'`, bare `import './x'` and literal `import('./x')`.
const RELATIVE = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
// A text scan, not a parser. It refuses two things it cannot follow: any file whose text names require or
// createRequire, and any import( call that is not exactly one quoted string literal. A load hidden from a text
// scan (a name built from strings, eval, a Function body) is not caught.
const OPAQUE_REQUIRE = /\b(?:createRequire|require)\b/;
const ANY_IMPORT_CALL = /\bimport\s*\(/g;
const LITERAL_IMPORT_CALL = /\bimport\s*\(\s*(['"])[^'"]*\1\s*\)/g;

/**
 * The runner `entry` and every module it reaches through relative imports, as plain file names in `dir`, entry
 * first. A module outside `dir` (a `../` or nested path) or one that is not a file throws, naming the importer.
 */
export function runnerFiles(dir, entry = 'sqlite-runner.mjs') {
  const found = [];
  const visit = (name, from) => {
    if (found.includes(name)) return;
    let isFile = false;
    try {
      isFile = statSync(join(dir, name)).isFile();
    } catch {
      // Reported below.
    }
    if (!isFile) throw new Error(`runner module ${name}${from ? ` (imported by ${from})` : ''} is not a file in ${dir}`);
    found.push(name);
    const text = readFileSync(join(dir, name), 'utf8');
    const calls = text.match(ANY_IMPORT_CALL)?.length ?? 0;
    const literal = text.match(LITERAL_IMPORT_CALL)?.length ?? 0;
    if (OPAQUE_REQUIRE.test(text) || calls !== literal) {
      throw new Error(`runner module ${name} names require/createRequire or an import() that is not one string literal: use a static import so the build can copy it`);
    }
    for (const [, , spec] of text.matchAll(RELATIVE)) {
      const sibling = spec.slice(2);
      if (!spec.startsWith('./') || sibling.includes('/') || sibling.includes('\\')) {
        throw new Error(`runner module ${name} imports ${spec}: a runner may import only files beside it`);
      }
      visit(sibling, name);
    }
  };
  visit(entry, null);
  return found;
}
