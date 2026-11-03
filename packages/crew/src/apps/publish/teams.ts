/**
 * (DES-APPS-001 §8.3, slice K6) The Microsoft Teams app package a publish with the `teams` target produces: a zip of
 * the Teams app manifest (one personal static tab that opens the site, Teams SSO through `webApplicationInfo`) and
 * its two icons. No secret is in it (the site is a public client, DES §8.3). K6b certifies it on a tenant.
 *
 * Written with Node's own zlib (deflate for the PNGs, CRC-32 for both formats): no new dependency.
 */

import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

import type { AppPublishManifest } from '../../core/types.js';

/** A solid square PNG (8-bit RGBA), `size` pixels on a side. */
export function solidPng(size: number, rgba: [number, number, number, number]): Buffer {
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) row.set(rgba, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A zip of `files` (stored, no compression), with a fixed date so the same input is the same bytes. */
export function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A stable Teams app id for (app, client): the same app republished keeps its tab. */
function appId(m: AppPublishManifest): string {
  const h = createHash('sha256').update(`wicked-apps-teams\u0000${m.app.slug}\u0000${m.identity?.clientId ?? ''}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The Teams app manifest for the published site (personal static tab, SSO for the site's own `access_as_user`). */
export function teamsManifest(m: AppPublishManifest): Record<string, unknown> {
  const site = new URL(m.site.origin);
  const name = m.app.name.slice(0, 30);
  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: `1.0.${m.app.version}`,
    id: appId(m),
    developer: { name: 'wicked Apps', websiteUrl: `${m.site.origin}/`, privacyUrl: `${m.site.origin}/`, termsOfUseUrl: `${m.site.origin}/` },
    name: { short: name, full: m.app.name.slice(0, 100) },
    description: { short: `${name} (read-only in Teams)`.slice(0, 80), full: `${m.app.name}: open it here to view; actions open the site in your browser.`.slice(0, 4000) },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#224A5E',
    staticTabs: [{ entityId: 'app', name, contentUrl: `${m.site.origin}/`, websiteUrl: `${m.site.origin}/`, scopes: ['personal'] }],
    permissions: ['identity'],
    validDomains: [site.host],
    webApplicationInfo: { id: m.identity?.clientId ?? '', resource: `api://${site.host}/${m.identity?.clientId ?? ''}` },
  };
}

export function teamsPackage(m: AppPublishManifest): Buffer {
  return zip([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(teamsManifest(m), null, 2)}\n`, 'utf8') },
    { name: 'color.png', data: solidPng(192, [0x22, 0x4a, 0x5e, 0xff]) },
    { name: 'outline.png', data: solidPng(32, [0xff, 0xff, 0xff, 0xff]) },
  ]);
}
