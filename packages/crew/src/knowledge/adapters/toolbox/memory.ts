// crew#1320: resident bytes, from the host; an unreadable sample must stop the pending read.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { childEnvWithBootEstateDb } from '../../../core/governance-store.js';

const exec = promisify(execFile);

export async function processMemory(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    let kb: number;
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (rss === null) return null;
      kb = Number(rss[1]);
    } else if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 10_000, encoding: 'utf8', env: childEnvWithBootEstateDb() });
      if (!/^\s*\d+\s*$/.test(stdout)) return null;
      kb = Number(stdout.trim());
    } else if (process.platform === 'win32') {
      const { stdout } = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10_000, encoding: 'utf8', windowsHide: true, env: childEnvWithBootEstateDb() });
      const columns = [...stdout.trim().matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) => m[1]!);
      // "Mem Usage" is always in KB; its unit word and digit grouping are localized (K, Ko, КБ; ',', '.', NBSP), so
      // only the digits are read (crew#1719 coord r1).
      const digits = (columns[4] ?? '').replace(/\D/g, '');
      if (columns[1] !== String(pid) || digits === '') return null;
      kb = Number(digits);
    } else {
      return null;
    }
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}
