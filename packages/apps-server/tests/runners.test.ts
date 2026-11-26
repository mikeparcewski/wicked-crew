// crew#1956: the image carries every module crew's SQLite runner imports. Published app images missed
// upload-parse.mjs (imported since crew#1721), so every upload source answered 503 in the container.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { runnerFiles } from '../scripts/runner-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const crewRunners = join(here, '..', '..', 'crew', 'runners');
// The built server artifact (npm run build, before these tests in CI): what a publish copies into the image.
const distRunners = join(here, '..', 'dist', 'runners');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'runner-files-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('the runner files a build copies', () => {
  it('follows every relative import form, recursively, entry first', () => {
    const dir = fixture({
      'sqlite-runner.mjs': "import { a } from './a.mjs';\nimport './b.mjs';\nexport { c } from \"./c.mjs\";\nconst d = await import('./d.mjs');\nimport { x } from 'node:fs';\n",
      'a.mjs': "import { b } from './b.mjs';\n", 'b.mjs': '', 'c.mjs': "import './e.mjs';\n", 'd.mjs': '', 'e.mjs': '',
    });
    expect(runnerFiles(dir)).toEqual(['sqlite-runner.mjs', 'a.mjs', 'b.mjs', 'c.mjs', 'e.mjs', 'd.mjs']);
  });

  it('fails when the runner imports a module that is not there (the build stops, not the container)', () => {
    const dir = fixture({ 'sqlite-runner.mjs': "import { parseCsv } from './upload-parse.mjs';\n" });
    expect(() => runnerFiles(dir)).toThrow(/upload-parse\.mjs \(imported by sqlite-runner\.mjs\) is not a file/);
  });

  it('refuses an import from outside the runners directory', () => {
    for (const spec of ['../src/x.mjs', './sub/x.mjs']) {
      const dir = fixture({ 'sqlite-runner.mjs': `import './x.mjs';\n`, 'x.mjs': `import '${spec}';\n`, 'sub/x.mjs': '' });
      expect(() => runnerFiles(dir)).toThrow(/a runner may import only files beside it/);
    }
  });

  it('fails on a load it cannot follow: require() or a computed import()', () => {
    for (const load of ["const r = createRequire(import.meta.url); r('./x.mjs');", "const m = './x.mjs'; await import(m);"]) {
      const dir = fixture({ 'sqlite-runner.mjs': `import { createRequire } from 'node:module';\n${load}\n`, 'x.mjs': '' });
      expect(() => runnerFiles(dir)).toThrow(/use a static import so the build can copy it/);
    }
  });

  it("derives crew's own set: the runner and upload-parse.mjs", () => {
    expect(runnerFiles(crewRunners)).toEqual(expect.arrayContaining(['sqlite-runner.mjs', 'upload-parse.mjs']));
  });
});

describe('the built artifact', () => {
  it('records the derived set in runners/files.json', () => {
    expect(JSON.parse(readFileSync(join(distRunners, 'files.json'), 'utf8'))).toEqual(runnerFiles(crewRunners));
  });

  it('runs its own runner: inspect on a SQLite snapshot answers ok (ERR_MODULE_NOT_FOUND before crew#1956)', () => {
    const dir = fixture({});
    const path = join(dir, 'snap.sqlite');
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE rules (type TEXT, n INTEGER); INSERT INTO rules VALUES ('a', 1);");
    db.close();
    const request = JSON.stringify({ op: 'inspect', uri: `${pathToFileURL(path).href}?immutable=1` });
    let answer: string;
    try {
      answer = execFileSync(process.execPath, [join(distRunners, 'sqlite-runner.mjs')], { input: request, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`the built runner did not start: ${String((e as { stderr?: string }).stderr ?? e).split('\n').find((l) => l.includes('Error')) ?? e}`);
    }
    expect(JSON.parse(answer)).toMatchObject({ ok: true, objects: [expect.objectContaining({ name: 'rules' })] });
  });
});
