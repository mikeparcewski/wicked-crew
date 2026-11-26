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
// Loads this scan cannot follow: require() (createRequire) and import() of anything but a string literal.
const OPAQUE = /\b(?:createRequire|require)\s*\(|\bimport\s*\(\s*[^'"\s]/;

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
    if (OPAQUE.test(text)) {
      throw new Error(`runner module ${name} loads a module through require() or a computed import(): use a static import so the build can copy it`);
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
