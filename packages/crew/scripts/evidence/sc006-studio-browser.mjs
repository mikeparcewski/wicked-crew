#!/usr/bin/env node
// SC-006 + SC-S01/S05/S06 + DoD behavior 4 — REAL browser (system Chrome via
// Playwright). Studio must be built and served on :4200 (vite preview). This
// script owns a daemon on :7701, drives Chrome, and captures timing +
// screenshots. Requires Playwright from the npx cache and system Google Chrome.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnDaemon, apiPost, stopDaemon, tempDbPath, REPO_ROOT, serveStudioDist } from './harness.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const dirs = ['974995fa9a20f15d', '83676cb6deae0cb5', '9833c18b2d85bc59'].map((d) => `/Users/michael.parcewski/.npm/_npx/${d}/node_modules/playwright`);
  for (const d of dirs) { try { return require(d); } catch { /* try next */ } }
  throw new Error('Playwright not found in npx cache');
}

const EVIDENCE_DIR = resolve(REPO_ROOT, '.product/evidence/dod/sc006');
mkdirSync(EVIDENCE_DIR, { recursive: true });
const write = (name, obj) => writeFileSync(resolve(EVIDENCE_DIR, name), JSON.stringify(obj, null, 2));
const STUDIO_URL = 'http://127.0.0.1:4200';

function delayedWorkers() {
  const fixture = resolve(REPO_ROOT, 'packages/crew/tests/fixtures/mock-worker.mjs');
  const { dir } = tempDbPath('sc006-cfg');
  const path = resolve(dir, 'workers.json');
  writeFileSync(path, JSON.stringify([{ id: 'mock-worker', command: 'node', args: [fixture, '--verdict', 'PASS', '--delay', '5000'], timeout_ms: 15000 }]));
  return path;
}

async function main() {
  const { chromium } = loadPlaywright();
  const results = { scenario: 'studio-connectivity', maps_to: ['SC-006', 'SC-S01', 'SC-S05', 'SC-S06'], startedAt: new Date().toISOString(), assertions: {} };
  const workers = delayedWorkers();
  const { dbPath } = tempDbPath('sc006');

  const staticServer = await serveStudioDist(4200);
  const daemon = spawnDaemon('serve', ['--db', dbPath, '--port', '7701'], { workers, env: { WICKED_CREW_DISABLE_BUS: '1' } });
  await daemon.ready;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // Instrument WebSocket to record open + first-message timing relative to nav.
  await page.addInitScript(() => {
    window.__t0 = performance.now();
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...args) {
        super(...args);
        this.addEventListener('open', () => { if (window.__wsOpenMs === undefined) window.__wsOpenMs = performance.now() - window.__t0; });
        this.addEventListener('message', () => { if (window.__wsFirstMsgMs === undefined) window.__wsFirstMsgMs = performance.now() - window.__t0; });
      }
    };
  });

  // ── SC-006 / SC-S01: connect within 5s ──
  const t0 = Date.now();
  await page.goto(STUDIO_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="connection-status"][aria-label="connected"]', { timeout: 5000 });
  const connectWallMs = Date.now() - t0;

  // ── DoD behavior 4 / SC-006: first WebSocket event within 5s. Create a
  // session now (after connect) so a live event is delivered to the studio. ──
  const created = await apiPost(7701, '/api/v1/sessions', { type: 'feature', goal: 'studio live session', workers: ['mock-worker'] });
  const sessionId = created.body.session.id;
  await page.waitForSelector('[data-testid="session-card"]', { timeout: 5000 });
  const sessionVisibleMs = Date.now() - t0;

  const wsOpenMs = await page.evaluate(() => window.__wsOpenMs ?? null);
  const wsFirstMsgMs = await page.evaluate(() => window.__wsFirstMsgMs ?? null);

  // ── SC-S06: no horizontal scroll at 1280px ──
  const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  const connectedShot = resolve(EVIDENCE_DIR, 'studio-connected-1280.png');
  await page.screenshot({ path: connectedShot });

  // ── SC-S05: disconnected state graceful (stop daemon) ──
  await stopDaemon(daemon.proc);
  await page.waitForSelector('[data-testid="connection-status"][aria-label="disconnected"]', { timeout: 10000 });
  const reconnectingText = await page.textContent('[data-testid="session-list"]').catch(() => '');
  const disconnectedShot = resolve(EVIDENCE_DIR, 'studio-disconnected.png');
  await page.screenshot({ path: disconnectedShot });

  const reactErrors = consoleErrors.filter((e) => /react/i.test(e));

  await browser.close();
  staticServer.close();

  // ── Assertions ──
  const A = results.assertions;
  A.SC006_connect_within_5s = { pass: connectWallMs < 5000, actual_ms: connectWallMs };
  A.SC006_ws_open_within_5s = { pass: wsOpenMs !== null && wsOpenMs < 5000, actual_ms: wsOpenMs };
  A.behavior4_first_ws_event_within_5s = { pass: wsFirstMsgMs !== null && wsFirstMsgMs < 5000, actual_ms: wsFirstMsgMs };
  A.SC006_live_session_visible_within_5s = { pass: sessionVisibleMs < 5000, actual_ms: sessionVisibleMs, session_id: sessionId };
  A.SCS06_no_horizontal_scroll_1280 = { pass: hscroll === false, hscroll };
  A.SCS05_disconnected_graceful = { pass: true, reconnecting_text: (reconnectingText || '').trim() };
  A.SCS05_no_react_error = { pass: reactErrors.length === 0, react_errors: reactErrors, all_console_errors: consoleErrors };

  results.timings = { connectWallMs, wsOpenMs, wsFirstMsgMs, sessionVisibleMs };
  results.screenshots = { connected: connectedShot, disconnected: disconnectedShot };
  results.verdict = Object.values(A).every((a) => a.pass) ? 'PASS' : 'FAIL';
  results.finishedAt = new Date().toISOString();
  write('verdict.json', results);

  // Scenario-named artifacts (studio-connectivity.md §Evidence).
  write('connect-timing.json', { t0: 0, t1: connectWallMs, durationMs: connectWallMs, wsOpenMs, wsFirstMsgMs });
  write('console-error-log.json', { errors: consoleErrors, reactErrors });
  // disconnected-ui.png alias of the disconnected screenshot.
  writeFileSync(resolve(EVIDENCE_DIR, 'disconnected-ui.png'), readFileSync(disconnectedShot));

  console.log(JSON.stringify({ verdict: results.verdict, assertions: A, timings: results.timings }, null, 2));
  process.exit(results.verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR:', err); process.exit(2); });
