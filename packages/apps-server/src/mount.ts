/**
 * Whether a directory is a mount point (DES §7.3: action records live on a PERSISTENT volume, and actions
 * are refused when none is mounted). Linux: `/proc/self/mountinfo` lists it. Elsewhere: it sits on another
 * device than its parent.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** mountinfo escapes space, tab, newline and backslash as octal. */
const unescape = (s: string): string => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));

export function isMountPoint(dir: string, mountinfo = '/proc/self/mountinfo'): boolean {
  const target = resolve(dir);
  if (!existsSync(target)) return false;
  if (existsSync(mountinfo)) {
    for (const line of readFileSync(mountinfo, 'utf8').split('\n')) {
      const fields = line.split(' ');
      if (fields.length > 4 && unescape(fields[4]!) === target) return true;
    }
    return false;
  }
  try {
    return statSync(target).dev !== statSync(dirname(target)).dev;
  } catch {
    return false;
  }
}
