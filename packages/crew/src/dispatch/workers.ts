import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkerConfig } from './types.js';

let workers: Map<string, WorkerConfig> = new Map();
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function loadWorkers(configPath: string): Map<string, WorkerConfig> {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as WorkerConfig[];
  const map = new Map<string, WorkerConfig>();
  for (const w of raw) map.set(w.id, w);
  return map;
}

export function startWorkerHotReload(configPath: string, pollIntervalSeconds = 30): void {
  const absolutePath = resolve(configPath);
  workers = loadWorkers(absolutePath);

  try {
    // fs.watch primary — may miss atomic writes from editors on Linux
    watch(absolutePath, { persistent: false }, () => {
      try { workers = loadWorkers(absolutePath); } catch { /* invalid JSON mid-write — skip */ }
    });
  } catch {
    // fs.watch unavailable on this platform — poll only
  }

  // Poll fallback: covers editor atomic writes (vim, VS Code unlink+rename breaks inotify)
  pollTimer = setInterval(() => {
    try { workers = loadWorkers(absolutePath); } catch { /* skip invalid JSON */ }
  }, pollIntervalSeconds * 1000);
}

export function stopWorkerHotReload(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function getWorker(id: string): WorkerConfig {
  const w = workers.get(id);
  if (!w) throw new Error(`Worker '${id}' not found in registry`);
  return w;
}

export function listWorkers(): WorkerConfig[] {
  return [...workers.values()];
}

export function setWorkers(map: Map<string, WorkerConfig>): void {
  workers = map;
}
