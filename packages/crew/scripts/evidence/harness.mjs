// Shared evidence-harness helpers. Spawns the REAL built daemon as a subprocess,
// interacts over REST/WS, and can SIGKILL it. Cross-platform (no shell strings).
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../../../..');
export const DAEMON_BIN = resolve(REPO_ROOT, 'packages/crew/dist/cli/index.js');
export const TEST_WORKERS = resolve(__dirname, 'test-workers.json');

export function tempDbPath(tag = 'evi') {
  const dir = mkdtempSync(join(tmpdir(), `crew-${tag}-`));
  return { dir, dbPath: join(dir, 'test.db') };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Serve the built studio SPA (packages/studio/dist) from a tiny static server,
// so browser harnesses are self-contained (no external `vite preview`).
export async function serveStudioDist(port) {
  const { createServer } = await import('node:http');
  const { readFileSync, existsSync } = await import('node:fs');
  const { join, extname } = await import('node:path');
  const dist = resolve(REPO_ROOT, 'packages/studio/dist');
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const server = createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    let filePath = join(dist, urlPath === '/' ? 'index.html' : urlPath);
    if (!existsSync(filePath)) filePath = join(dist, 'index.html');
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)));
}

export async function poll(fn, { maxMs = 20000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > maxMs) throw new Error(`poll timeout waiting for ${label} after ${maxMs}ms`);
    await sleep(intervalMs);
  }
}

/**
 * Spawn a daemon subprocess and resolve once it prints WICKED_CREW_READY.
 * command is one of 'serve' | 'start' | 'resume'. Returns
 * { proc, ready, spawnToReadyMs, stdout(), stderr() }.
 */
export function spawnDaemon(command, args, { workers = TEST_WORKERS, env = {} } = {}) {
  const t0 = Date.now();
  const fullArgs = [DAEMON_BIN, command, '--workers', workers, ...args];
  const proc = spawn('node', fullArgs, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });

  const ready = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`daemon did not become ready in 15s. stderr:\n${err}\nstdout:\n${out}`)), 15000);
    const check = setInterval(() => {
      const line = out.split('\n').find((l) => l.startsWith('WICKED_CREW_READY'));
      if (line) {
        clearTimeout(timer);
        clearInterval(check);
        const json = JSON.parse(line.slice('WICKED_CREW_READY '.length));
        resolvePromise({ ...json, spawnToReadyMs: Date.now() - t0 });
      }
    }, 25);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        clearInterval(check);
        rejectPromise(new Error(`daemon exited early with code ${code}. stderr:\n${err}`));
      }
    });
  });

  return { proc, ready, stdout: () => out, stderr: () => err };
}

export async function apiGet(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

export async function apiPost(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

export function stopDaemon(proc) {
  return new Promise((resolvePromise) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolvePromise();
    proc.on('exit', () => resolvePromise());
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } resolvePromise(); }, 3000);
  });
}

export function sigkillDaemon(proc) {
  return new Promise((resolvePromise) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolvePromise();
    proc.on('exit', () => resolvePromise());
    proc.kill('SIGKILL');
    setTimeout(() => resolvePromise(), 2000);
  });
}
