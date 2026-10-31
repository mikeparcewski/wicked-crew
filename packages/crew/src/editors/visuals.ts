/**
 * How an editor looks on studio's Plugins page (program DES-LEARN §2): one line (`description`) and its `visuals`
 * — an icon on its colour, a preview image (light and dark), and whether studio may draw a live preview.
 *
 * The manifest names image FILES beside it, in the studio bundle's `editors/<id>/` directory (studio-bundle editors
 * only for now: garden's pack gate refuses the keys, and a pack's images would need descriptor-anchored reads). The
 * registry reads each once, bounded, never through a link, and puts it on the wire as a `data:`
 * URL: no path and no remote URL ever reaches the browser, and an image is never served from crew's own origin (an SVG
 * opened there could run script; as an `<img src="data:…">` it cannot).
 *
 * Cosmetic and fail-open: a missing, oversized, linked or malformed image is dropped with a logged reason, and the
 * editor itself is still served.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { EditorVisuals } from '../core/types.js';
import { notRealEntry } from './registry.js';

/** The most an icon file may weigh (DES-LEARN §1.2: SVG ≤ 16 KB). */
export const ICON_CAP_BYTES = 16 * 1024;
/** The most a preview image may weigh (DES-LEARN §1.2: ≤ 200 KB). */
export const PREVIEW_CAP_BYTES = 200 * 1024;
/** The most characters of an editor's one line. */
export const DESCRIPTION_CHARS = 160;

const FILE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/u;
const HEX = /^#[0-9a-fA-F]{6}$/u;
const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

/** The manifest's `visuals`, as declared (file names, not yet read). */
export interface DeclaredVisuals {
  icon?: string;
  color?: string;
  preview?: string | { light?: string; dark?: string };
  live?: boolean;
}

/** A declared `visuals` value, strictly: anything malformed is dropped (field by field), never refused. */
export function declaredVisuals(raw: unknown): DeclaredVisuals | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const file = (v: unknown): string | undefined => (typeof v === 'string' && FILE.test(v) && !v.split('/').includes('..') && MIME[extname(v).toLowerCase()] !== undefined ? v : undefined);
  const out: DeclaredVisuals = {};
  const icon = file(r['icon']);
  if (icon !== undefined) out.icon = icon;
  if (typeof r['color'] === 'string' && HEX.test(r['color'])) out.color = r['color'];
  const pv = r['preview'];
  if (typeof pv === 'string') {
    const p = file(pv);
    if (p !== undefined) out.preview = p;
  } else if (typeof pv === 'object' && pv !== null && !Array.isArray(pv)) {
    const light = file((pv as Record<string, unknown>)['light']);
    const dark = file((pv as Record<string, unknown>)['dark']);
    if (light !== undefined || dark !== undefined) out.preview = { ...(light !== undefined ? { light } : {}), ...(dark !== undefined ? { dark } : {}) };
  }
  if (r['live'] === true) out.live = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A one-line description, or undefined. */
export function declaredDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = raw.replace(/\s+/gu, ' ').trim();
  return line === '' ? undefined : line.slice(0, DESCRIPTION_CHARS);
}

/** Does the file's head match its type? (A PNG named `.webp`, or HTML named `.svg`, is not an image of that type.) */
function looksLike(buf: Buffer, ext: string): boolean {
  if (ext === '.png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.webp') return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  const head = buf.subarray(0, 512).toString('utf8').replace(/^﻿/u, '').trimStart();
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(head);
}

/**
 * Read one image the manifest names, relative to `root`: inside it, every directory on the way and the file itself
 * real (never a link), within `cap`, and of the type its name says. A `data:` URL, or null with the reason logged.
 */
export function imageDataUrl(root: string, name: string, cap: number, why: (m: string) => void): string | null {
  const path = resolve(root, name);
  const rel = relative(resolve(root), path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) { why(`${name} is outside its directory`); return null; }
  let at = resolve(root);
  for (const part of rel.split(sep).slice(0, -1)) {
    at = join(at, part);
    const p = notRealEntry(at, 'dir');
    if (p !== null) { why(`${name}: directory ${part} is ${p}`); return null; }
  }
  const problem = notRealEntry(path, 'file');
  if (problem !== null) { why(`${name} is ${problem}`); return null; }
  let buf: Buffer | null;
  try {
    buf = readNoFollow(path, cap);
  } catch (err) {
    why(`${name} is unreadable (${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err)})`);
    return null;
  }
  if (buf === null) { why(`${name} is over its ${cap}-byte cap, or changed while it was read`); return null; }
  const ext = extname(name).toLowerCase();
  if (!looksLike(buf, ext)) { why(`${name} is not a ${ext.slice(1)} image`); return null; }
  return `data:${MIME[ext]!};base64,${buf.toString('base64')}`;
}

/**
 * Read at most `cap` bytes of a file, never through a link (codex on crew#1234): the open refuses a link swapped in
 * for the file after the check (O_NOFOLLOW where the platform has it), and the open file must be the regular file
 * that was checked (same device and inode). Null = over the cap, or not the checked file.
 */
export function readNoFollow(path: string, cap: number, checked: { ino: number; dev: number } = lstatSync(path)): Buffer | null {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== checked.ino || st.dev !== checked.dev || st.size > cap) return null;
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > cap) return null;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Resolve the declared visuals against the files beside the manifest. Undefined when nothing survives. */
export function resolveVisuals(root: string, declared: DeclaredVisuals | undefined, log: (m: string) => void): EditorVisuals | undefined {
  if (declared === undefined) return undefined;
  const out: EditorVisuals = {};
  if (declared.icon !== undefined) {
    const icon = imageDataUrl(root, declared.icon, ICON_CAP_BYTES, log);
    if (icon !== null) out.icon = icon;
  }
  if (declared.color !== undefined) out.color = declared.color;
  if (declared.preview !== undefined) {
    const files = typeof declared.preview === 'string' ? { light: declared.preview } : declared.preview;
    const light = files.light !== undefined ? imageDataUrl(root, files.light, PREVIEW_CAP_BYTES, log) : null;
    const dark = files.dark !== undefined ? imageDataUrl(root, files.dark, PREVIEW_CAP_BYTES, log) : null;
    if (light !== null || dark !== null) out.preview = { ...(light !== null ? { light } : {}), ...(dark !== null ? { dark } : {}) };
  }
  if (declared.live === true) out.live = true;
  return Object.keys(out).length > 0 ? out : undefined;
}
