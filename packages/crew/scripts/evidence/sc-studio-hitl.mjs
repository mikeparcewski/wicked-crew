#!/usr/bin/env node
// SC-S02 (gate notification < 2s of WS message) + SC-S03 (studio Approve
// advances the phase in wicked-crew < 3s) + DoD studio requirement "human
// approval via studio advances the gate". REAL browser (system Chrome via
// Playwright) against a REAL daemon; the built studio SPA is served by a tiny
// static server so this harness is self-contained.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { spawnDaemon, apiPost, apiGet, poll, stopDaemon, tempDbPath, REPO_ROOT } from './harness.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const dirs = ['974995fa9a20f15d', '83676cb6deae0cb5', '9833c18b2d85bc59'].map((d) => `/Users/michael.parcewski/.npm/_npx/${d}/node_modules/playwright`);
  for (const d of dirs) { try { return require(d); } catch { /* next */ } }
  throw new Error('Playwright not found');
}

const EVIDENCE_DIR = resolve(REPO_ROOT, '.product/evidence/dod/sc-studio-hitl');
mkdirSync(EVIDENCE_DIR, { recursive: true });
const write = (name, obj) => writeFileSync(resolve(EVIDENCE_DIR, name), JSON.stringify(obj, null, 2));
// The bundled studio dist (build:with-studio output; SPA source lives in its own
// repo since the #98 carve). Override with STUDIO_DIST for any other built dist.
const DIST = process.env.STUDIO_DIST ?? resolve(REPO_ROOT, 'packages/crew/dist/studio');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStudio(port) {
  const server = createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    let filePath = join(DIST, urlPath === '/' ? 'index.html' : urlPath);
    if (!existsSync(filePath)) filePath = join(DIST, 'index.html'); // SPA fallback
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)));
}

function delayedWorkers() {
  const fixture = resolve(REPO_ROOT, 'packages/crew/tests/fixtures/mock-worker.mjs');
  const { dir } = tempDbPath('scshitl-cfg');
  const path = resolve(dir, 'workers.json');
  writeFileSync(path, JSON.stringify([{ id: 'mock-worker', command: 'node', args: [fixture, '--verdict', 'PASS', '--delay', '2500'], timeout_ms: 15000 }]));
  return path;
}

async function main() {
  const { chromium } = loadPlaywright();
  const results = { scenario: 'studio-hitl-flow', maps_to: ['SC-S02', 'SC-S03'], startedAt: new Date().toISOString(), assertions: {} };
  const workers = delayedWorkers();
  const { dbPath } = tempDbPath('scshitl');

  const staticServer = await serveStudio(4200);
  const daemon = spawnDaemon('serve', ['--db', dbPath, '--port', '7701'], { workers, env: { WICKED_CREW_DISABLE_BUS: '1' } });
  await daemon.ready;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // Record, in-page, when the gate 'awaiting_human' WS message arrives.
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (ev) => {
          try {
            const d = JSON.parse(ev.data);
            if (d.type === 'wicked.crew.gate.awaiting_human' && window.__gateMsgMs === undefined) window.__gateMsgMs = performance.now();
          } catch { /* skip */ }
        });
      }
    };
  });

  await page.goto('http://127.0.0.1:4200', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="connection-status"][aria-label="connected"]', { timeout: 5000 });

  // Create a session with a human gate at design AFTER connect, so the studio
  // receives the awaiting_human event live.
  const created = await apiPost(7701, '/api/v1/sessions', { type: 'feature', goal: 'studio hitl', workers: ['mock-worker'], phase_gate_overrides: { design: 'human' } });
  const sessionId = created.body.session.id;

  // SC-S02 — notification badge appears; measure vs the WS message arrival.
  await page.waitForSelector('[data-testid="gate-notification"]', { timeout: 8000 });
  const gateBadgeMs = await page.evaluate(() => performance.now());
  const gateMsgMs = await page.evaluate(() => window.__gateMsgMs ?? null);
  const notifyDeltaMs = gateMsgMs !== null ? Math.round(gateBadgeMs - gateMsgMs) : null;

  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'gate-notification.png') });

  // SC-S03 — click Approve; measure until the daemon advances design → Approved.
  const t2 = Date.now();
  await page.click('[data-testid="gate-panel-approve"]');
  let advanceMs;
  try {
    await poll(async () => {
      const p = await apiGet(7701, `/api/v1/sessions/${sessionId}/phases`);
      return p.phases.some((x) => x.phase_id === 'design' && x.state === 'Approved');
    }, { maxMs: 8000, intervalMs: 50, label: 'design Approved via studio' });
    advanceMs = Date.now() - t2;
  } catch (e) {
    const p = await apiGet(7701, `/api/v1/sessions/${sessionId}/phases`).catch(() => ({ phases: [] }));
    console.error('DIAG phase states after click:', JSON.stringify(Object.fromEntries(p.phases.map((x) => [x.phase_id, x.state]))));
    console.error('DIAG console errors:', JSON.stringify(consoleErrors));
    throw e;
  }

  const phases = await apiGet(7701, `/api/v1/sessions/${sessionId}/phases`);
  const ts = phases.phases.find((x) => x.phase_id === 'test-strategy');

  await browser.close();
  await stopDaemon(daemon.proc);
  staticServer.close();

  const A = results.assertions;
  A.SCS02_notification_within_2s = { pass: notifyDeltaMs !== null && notifyDeltaMs < 2000, actual_ms: notifyDeltaMs, gate_msg_ms: gateMsgMs, badge_ms: Math.round(gateBadgeMs) };
  A.SCS03_approve_advances_within_3s = { pass: advanceMs < 3000, actual_ms: advanceMs };
  A.SCS03_next_phase_started = { pass: !!ts && ts.state !== 'Pending', actual: ts?.state };
  A.no_react_error = { pass: consoleErrors.filter((e) => /react/i.test(e)).length === 0, console_errors: consoleErrors };

  results.timings = { notifyDeltaMs, advanceMs };
  results.session_id = sessionId;
  results.verdict = Object.values(A).every((a) => a.pass) ? 'PASS' : 'FAIL';
  results.finishedAt = new Date().toISOString();
  write('verdict.json', results);

  console.log(JSON.stringify({ verdict: results.verdict, assertions: A, timings: results.timings }, null, 2));
  process.exit(results.verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR:', err); process.exit(2); });
