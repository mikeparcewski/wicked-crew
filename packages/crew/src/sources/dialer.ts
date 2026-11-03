/**
 * The ONE dialer (DES-APPS-001 §5.2, S10): every outbound connection crew makes to a source — a spec
 * download, a describe, a test call, a query, an action, an `mcp-http` server's calls, OIDC discovery
 * and keys — goes through here. `mcp-stdio` is outside it by design: a local program the person
 * installed, whose own network use is trusted like any program they run.
 *
 * What it does, in order, for every connection:
 *
 * 1. **Resolve once.** A name is resolved exactly once per connection (all addresses, verbatim).
 * 2. **Normalize.** An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, `::ffff:7f00:1`) is judged and
 *    dialled as the IPv4 address it is. Forms that embed an IPv4 address the dialer cannot judge
 *    (IPv4-compatible `::a.b.c.d`, SIIT `::ffff:0:a.b.c.d`, NAT64 `64:ff9b::/96` and
 *    `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo `2001::/32`) are refused, as are zone ids.
 * 3. **Check every address.** One refused address refuses the connection, so a name that answers a
 *    public and a metadata address cannot be steered between them. The default is global unicast
 *    only. A loopback or private range (127/8, ::1, 10/8, 172.16/12, 192.168/16, fc00::/7) is allowed
 *    only when the person confirmed a range covering it for THIS source ({@link AddressPolicy}).
 *    "This network" (0/8), link-local (169.254/16 and fe80::/10, which hold the cloud metadata
 *    address 169.254.169.254), CGNAT (100.64/10), the AWS IPv6 metadata address `fd00:ec2::254`,
 *    multicast, documentation, benchmarking and reserved ranges are ALWAYS refused and cannot be
 *    confirmed.
 * 4. **Connect to the checked address**, never to the name again: TCP goes to that address (a
 *    pinned `lookup` for HTTP), while the hostname is kept for TLS (SNI and certificate checks), so a
 *    record that re-resolves between the check and the connection (DNS rebinding) changes nothing.
 * 5. **Refuse redirects.** Any 3xx is refused, never followed.
 * 6. **TLS by default.** HTTPS only; plaintext `http:` only to loopback, or to a private range the
 *    person confirmed as plaintext. Certificates are verified (Node's defaults, TLS 1.2 or later).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { pipeline, Readable, Transform } from 'node:stream';
import { constants as zlibConstants, createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from 'node:zlib';

import { UpstreamCallError } from '../mcp/upstream-error.js';

// ── Addresses ────────────────────────────────────────────────────────────────────────────────

/** How the dialer classes one (normalized) address. */
export type AddressClass = 'global' | 'loopback' | 'private' | 'refused';

export interface ClassifiedAddress {
  /** The address as dialled: an IPv4-mapped address becomes its IPv4 form. */
  address: string;
  family: 4 | 6;
  cls: AddressClass;
  /** Why it is refused; `null` unless `cls` is `refused`. */
  why: string | null;
}

const V4_ALWAYS_REFUSED: ReadonlyArray<[string, number, string]> = [
  ['0.0.0.0', 8, '"this network" (0.0.0.0/8)'],
  ['169.254.0.0', 16, 'link-local (169.254.0.0/16, where cloud metadata lives)'],
  ['100.64.0.0', 10, 'carrier-grade NAT (100.64.0.0/10)'],
  ['192.0.0.0', 24, 'IETF protocol assignments (192.0.0.0/24)'],
  ['192.0.2.0', 24, 'documentation (192.0.2.0/24)'],
  ['192.88.99.0', 24, 'the 6to4 relay anycast (192.88.99.0/24)'],
  ['198.18.0.0', 15, 'benchmarking (198.18.0.0/15)'],
  ['198.51.100.0', 24, 'documentation (198.51.100.0/24)'],
  ['203.0.113.0', 24, 'documentation (203.0.113.0/24)'],
  ['224.0.0.0', 4, 'multicast (224.0.0.0/4)'],
  ['240.0.0.0', 4, 'reserved (240.0.0.0/4)'],
];
const V4_LOOPBACK: ReadonlyArray<[string, number]> = [['127.0.0.0', 8]];
const V4_PRIVATE: ReadonlyArray<[string, number]> = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]];

const V6_ALWAYS_REFUSED: ReadonlyArray<[string, number, string]> = [
  ['fd00:ec2::254', 128, 'the cloud metadata address (fd00:ec2::254)'],
  ['fd20:ce::254', 128, 'the cloud metadata address (fd20:ce::254)'],
  ['::', 128, 'the unspecified address (::)'],
  ['::', 96, 'an IPv4-compatible address (::/96, deprecated)'],
  ['::ffff:0:0:0', 96, 'an SIIT IPv4-translated address (::ffff:0:0:0/96)'],
  ['64:ff9b::', 96, 'a NAT64 address (64:ff9b::/96), which can reach any IPv4 address'],
  ['64:ff9b:1::', 48, 'a local-use NAT64 address (64:ff9b:1::/48), which can reach any IPv4 address'],
  ['100::', 64, 'the discard prefix (100::/64)'],
  // IETF protocol assignments (2001::/23): Teredo (which embeds an IPv4 address), benchmarking,
  // ORCHID, AMT, AS112 and the rest. No source lives there, so the whole block is refused.
  ['2001::', 23, 'IETF protocol assignments (2001::/23: Teredo, benchmarking, ORCHID, …)'],
  ['2001:db8::', 32, 'documentation (2001:db8::/32)'],
  ['3fff::', 20, 'documentation (3fff::/20)'],
  ['5f00::', 16, 'SRv6 SIDs (5f00::/16)'],
  ['2002::', 16, '6to4 (2002::/16), which embeds an IPv4 address'],
  ['fe80::', 10, 'link-local (fe80::/10)'],
  ['fec0::', 10, 'site-local (fec0::/10, deprecated)'],
  ['ff00::', 8, 'multicast (ff00::/8)'],
];
const V6_LOOPBACK: ReadonlyArray<[string, number]> = [['::1', 128]];
const V6_PRIVATE: ReadonlyArray<[string, number]> = [['fc00::', 7]];
const V6_GLOBAL: [string, number] = ['2000::', 3];

function v4ToBig(ip: string): bigint {
  const parts = ip.split('.').map((p) => Number(p));
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
}

function bigToV4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => String(Number((n >> s) & 0xffn))).join('.');
}

/** Parse an IPv6 literal (no brackets, no zone) to its 128-bit value; `null` = not one. */
function v6ToBig(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.toLowerCase();
  // An embedded dotted quad (`::ffff:1.2.3.4`) becomes two hex groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const v4 = v4ToBig(dotted[1] as string);
    text = `${text.slice(0, -(dotted[1] as string).length)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] as string).split(':')) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function inPrefix(addr: bigint, net: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return addr >> shift === net >> shift;
}

const v4In = (a: bigint, list: ReadonlyArray<readonly [string, number, ...unknown[]]>) =>
  list.find(([net, p]) => inPrefix(a, v4ToBig(net), p, 32));
const v6In = (a: bigint, list: ReadonlyArray<readonly [string, number, ...unknown[]]>) =>
  list.find(([net, p]) => inPrefix(a, v6ToBig(net) as bigint, p, 128));

/**
 * Normalize and class one address. An IPv4-mapped IPv6 address is classed (and dialled) as its
 * IPv4 address; every other embedding of IPv4 in IPv6 is refused. Anything that is not an IP
 * literal (a name, a zone id, garbage) is `refused`.
 */
export function classifyAddress(raw: string): ClassifiedAddress {
  const ip = raw.replace(/^\[|\]$/g, '');
  if (ip.includes('%')) return { address: ip, family: 6, cls: 'refused', why: 'an address with a zone id' };
  const family = isIP(ip);
  if (family === 4) {
    const a = v4ToBig(ip);
    const refused = V4_ALWAYS_REFUSED.find(([net, p]) => inPrefix(a, v4ToBig(net), p, 32));
    if (refused !== undefined) return { address: ip, family: 4, cls: 'refused', why: refused[2] };
    if (v4In(a, V4_LOOPBACK) !== undefined) return { address: ip, family: 4, cls: 'loopback', why: null };
    if (v4In(a, V4_PRIVATE) !== undefined) return { address: ip, family: 4, cls: 'private', why: null };
    return { address: ip, family: 4, cls: 'global', why: null };
  }
  if (family === 6) {
    const a = v6ToBig(ip);
    if (a === null) return { address: ip, family: 6, cls: 'refused', why: 'an unparseable IPv6 address' };
    // IPv4-mapped (::ffff:0:0/96): judged and dialled as the IPv4 address it carries.
    if (inPrefix(a, 0xffff00000000n, 96, 128)) return classifyAddress(bigToV4(a & 0xffffffffn));
    if (a === 1n) return { address: '::1', family: 6, cls: 'loopback', why: null };
    const refused = V6_ALWAYS_REFUSED.find(([net, p]) => inPrefix(a, v6ToBig(net) as bigint, p, 128));
    if (refused !== undefined) return { address: ip.toLowerCase(), family: 6, cls: 'refused', why: refused[2] };
    if (v6In(a, V6_LOOPBACK) !== undefined) return { address: ip.toLowerCase(), family: 6, cls: 'loopback', why: null };
    if (v6In(a, V6_PRIVATE) !== undefined) return { address: ip.toLowerCase(), family: 6, cls: 'private', why: null };
    if (!inPrefix(a, v6ToBig(V6_GLOBAL[0]) as bigint, V6_GLOBAL[1], 128)) {
      return { address: ip.toLowerCase(), family: 6, cls: 'refused', why: 'outside IPv6 global unicast (2000::/3)' };
    }
    return { address: ip.toLowerCase(), family: 6, cls: 'global', why: null };
  }
  return { address: ip, family: 4, cls: 'refused', why: 'not an IP address' };
}

// ── The person's confirmation ────────────────────────────────────────────────────────────────

/**
 * What the person confirmed for one source (DES §5.2): the loopback or private ranges its
 * connections may reach, and whether plaintext is accepted on a confirmed PRIVATE range (loopback
 * never needs it). Empty = global unicast only, HTTPS/TLS only. Always-refused ranges cannot be
 * confirmed ({@link validateAllowRanges}).
 */
export interface AddressPolicy {
  allow: string[];
  plaintext: boolean;
}

export const NO_CONFIRMATION: AddressPolicy = Object.freeze({ allow: Object.freeze([]) as unknown as string[], plaintext: false });

/** A source's policy: what it carries, or nothing confirmed. */
export function addressPolicyOf(config: { address?: AddressPolicy | null | undefined }): AddressPolicy {
  return config.address ?? NO_CONFIRMATION;
}

/**
 * The ranges a URL the person TYPED confirms by itself, and nothing more: an IP literal in a loopback
 * or private range confirms exactly that address (`/32` or `/128`: there is no name to re-resolve);
 * `localhost` confirms loopback (RFC 6761). A private host NAME confirms nothing: what it resolves
 * to can change, so its range must be confirmed explicitly.
 */
export function exactRangesFor(raw: string | null | undefined): string[] {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    return [];
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return ['127.0.0.0/8', '::1/128'];
  if (isIP(host) === 0) return [];
  const c = classifyAddress(host);
  if (c.cls !== 'loopback' && c.cls !== 'private') return [];
  return [`${c.address}/${c.family === 4 ? 32 : 128}`];
}

interface ParsedRange {
  family: 4 | 6;
  net: bigint;
  prefix: number;
}

function parseRange(cidr: string): ParsedRange | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
  if (m === null) return null;
  const ip = m[1] as string;
  const prefix = Number(m[2]);
  const family = isIP(ip);
  if (family === 4 && prefix <= 32) return { family: 4, net: v4ToBig(ip), prefix };
  if (family === 6 && prefix <= 128) {
    const net = v6ToBig(ip);
    return net === null ? null : { family: 6, net, prefix };
  }
  return null;
}

/**
 * Check a confirmation's ranges: each a CIDR lying wholly inside loopback (127/8, ::1/128) or a
 * private range (10/8, 172.16/12, 192.168/16, fc00::/7). Answers the problem, or `null` when every
 * range is acceptable. Global addresses need no confirmation; refused ones can never have one.
 */
export function validateAllowRanges(ranges: readonly string[]): string | null {
  for (const r of ranges) {
    const p = parseRange(r);
    if (p === null) return `${JSON.stringify(r)} is not a CIDR range (like 10.0.0.0/8 or fc00::/7)`;
    const within = (list: ReadonlyArray<readonly [string, number]>, bits: number, toBig: (s: string) => bigint) =>
      list.some(([net, prefix]) => p.prefix >= prefix && inPrefix(p.net, toBig(net), prefix, bits));
    const ok =
      p.family === 4
        ? within([...V4_LOOPBACK, ...V4_PRIVATE], 32, v4ToBig)
        : within([...V6_LOOPBACK, ...V6_PRIVATE], 128, (s) => v6ToBig(s) as bigint);
    if (!ok) {
      return `${r} is not inside a loopback or private range (127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7); only those can be confirmed`;
    }
    // A range lying wholly inside an always-refused one (the IPv6 metadata address inside fc00::/7)
    // confirms nothing the dialer would ever allow: refused, so no record or audit claims it.
    const isLoopbackV6 = p.family === 6 && p.prefix === 128 && p.net === 1n;
    const refusedList = p.family === 4 ? V4_ALWAYS_REFUSED : isLoopbackV6 ? [] : V6_ALWAYS_REFUSED;
    const toBig = p.family === 4 ? v4ToBig : (x: string) => v6ToBig(x) as bigint;
    const inside = refusedList.find(([net, prefix]) => p.prefix >= prefix && inPrefix(p.net, toBig(net), prefix, p.family === 4 ? 32 : 128));
    if (inside !== undefined) return `${r} lies inside ${inside[2]}, which is always refused and can never be confirmed`;
  }
  return null;
}

/** Whether two addresses are the same address, whatever their spelling (IPv4-mapped included). */
export function sameAddress(a: string, b: string): boolean {
  const ca = classifyAddress(a);
  const cb = classifyAddress(b);
  if (ca.family !== cb.family) return false;
  if (ca.family === 4) return ca.address === cb.address;
  return v6ToBig(ca.address) !== null && v6ToBig(ca.address) === v6ToBig(cb.address);
}

/** Whether `address` (normalized) lies in one of the confirmed ranges. */
function confirmed(address: ClassifiedAddress, policy: AddressPolicy): boolean {
  const a = address.family === 4 ? v4ToBig(address.address) : v6ToBig(address.address);
  if (a === null) return false;
  return policy.allow.some((r) => {
    const p = parseRange(r);
    return p !== null && p.family === address.family && inPrefix(a, p.net, p.prefix, address.family === 4 ? 32 : 128);
  });
}

/** Whether plaintext (no TLS) may be used to an address of this class under `policy`. */
export function plaintextAllowed(cls: AddressClass, policy: AddressPolicy): boolean {
  return cls === 'loopback' || (cls === 'private' && policy.plaintext);
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────

export type DialRefusalCode =
  | 'address_refused'
  | 'address_unconfirmed'
  | 'unresolved'
  | 'redirect_refused'
  | 'plaintext_refused'
  | 'url_refused';

/**
 * A connection the dialer refused, before any byte left (or, for a redirect, before it was
 * followed). An {@link UpstreamCallError} of class `boundary`: never retried, recorded as a
 * `guard_error` by the broker.
 */
export class DialRefusedError extends UpstreamCallError {
  constructor(
    readonly code: DialRefusalCode,
    message: string,
  ) {
    super('boundary', false, message);
    this.name = 'DialRefusedError';
  }
}

/** A 3xx answer: refused, never followed. Carries what was answered so a caller can say more. */
export class DialRedirectRefusedError extends DialRefusedError {
  constructor(
    readonly status: number,
    readonly location: string | null,
    message: string,
  ) {
    super('redirect_refused', message);
    this.name = 'DialRedirectRefusedError';
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────

/** Resolves a name to every address it has; `[]` when it does not resolve. Injectable for tests. */
export type Resolver = (hostname: string) => Promise<string[]>;

const RESOLVE_TIMEOUT_MS = 3_000;

export const systemResolver: Resolver = async (hostname) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const found = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), RESOLVE_TIMEOUT_MS);
      }),
    ]);
    return found.map((a) => a.address);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A checked target: every address the name resolved to (all of them checked), the one dialled
 * first, and the name kept for TLS. A connection may fall back across `addresses` (dual-stack
 * `localhost` is `::1` and `127.0.0.1`), never to anything else and never by resolving again.
 */
export interface DialTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  cls: AddressClass;
  addresses: ReadonlyArray<{ address: string; family: 4 | 6; cls: AddressClass }>;
}

/** Read through a call, so TypeScript does not keep an earlier narrowing across an await. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
}

/**
 * Resolve `host` once and check every address against `policy`. Throws {@link DialRefusedError}
 * naming the first address refused. An abort during resolution rejects at once and nothing dials.
 */
export async function resolveTarget(host: string, policy: AddressPolicy, resolver: Resolver = systemResolver, signal?: AbortSignal): Promise<DialTarget> {
  const hostname = host.replace(/^\[|\]$/g, '');
  if (hostname === '') throw new DialRefusedError('url_refused', 'the connection names no host');
  if (signal?.aborted === true) throw abortError(signal);
  const literal = isIP(hostname) !== 0 || hostname.includes('%');
  let answers: string[];
  if (literal) answers = [hostname];
  else if (signal === undefined) answers = await resolver(hostname);
  else {
    let onAbort: (() => void) | undefined;
    try {
      answers = await Promise.race([
        resolver(hostname),
        new Promise<never>((_r, reject) => {
          onAbort = () => reject(abortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }
  if (signal !== undefined && isAborted(signal)) throw abortError(signal);
  if (answers.length === 0) throw new DialRefusedError('unresolved', `${hostname} did not resolve, so crew could not check where it goes`);
  const checked = answers.map((a) => classifyAddress(a));
  for (const c of checked) {
    const named = literal ? c.address : `${hostname} (${c.address})`;
    if (c.cls === 'refused') throw new DialRefusedError('address_refused', `${named} is refused: ${c.why ?? 'not allowed'}; crew never connects there`);
    if ((c.cls === 'loopback' || c.cls === 'private') && !confirmed(c, policy)) {
      throw new DialRefusedError(
        'address_unconfirmed',
        `${named} is a ${c.cls} address, which a source reaches only when the person confirms a range covering it for that source (e.g. ${suggestRange(c)})`,
      );
    }
  }
  const unique = checked.filter((c, i) => checked.findIndex((d) => sameAddress(d.address, c.address)) === i);
  const first = unique[0] as ClassifiedAddress;
  return { hostname, address: first.address, family: first.family, cls: first.cls, addresses: unique.map((c) => ({ address: c.address, family: c.family, cls: c.cls })) };
}

/** Whether `remote` is one of the addresses the target was checked at. */
function isCheckedAddress(target: DialTarget, remote: string | undefined): boolean {
  return remote !== undefined && target.addresses.some((a) => sameAddress(a.address, remote));
}

/**
 * Refuse a scheme the target may not use: https always; plaintext http only where
 * {@link plaintextAllowed} for EVERY address the name resolved to. Used before any byte is sent, and
 * by a preview that only checks a base URL (so a preview never accepts what every call would refuse).
 */
export function checkScheme(url: URL, target: DialTarget, policy: AddressPolicy): void {
  if (url.protocol === 'https:') return;
  if (url.protocol !== 'http:') throw new DialRefusedError('url_refused', `${url.protocol} URLs are not dialled; https only`);
  const blocked = target.addresses.find((a) => !plaintextAllowed(a.cls, policy));
  if (blocked === undefined) return;
  throw new DialRefusedError(
    'plaintext_refused',
    blocked.cls === 'private'
      ? `plaintext http to ${url.host} (${blocked.address}) is refused: confirm this private range as plaintext for the source, or use https`
      : `plaintext http to ${url.host} is refused: use https (plaintext is only for loopback, or a private range the person confirmed as plaintext)`,
  );
}

/** The range a person would confirm for an address: its private or loopback block. */
export function suggestRange(c: Pick<ClassifiedAddress, 'address' | 'family' | 'cls'>): string {
  if (c.family === 6) return c.cls === 'loopback' ? '::1/128' : 'fc00::/7';
  const a = v4ToBig(c.address);
  const block = [...V4_LOOPBACK, ...V4_PRIVATE].find(([net, p]) => inPrefix(a, v4ToBig(net), p, 32));
  return block === undefined ? `${c.address}/32` : `${block[0]}/${block[1]}`;
}

// ── TCP ──────────────────────────────────────────────────────────────────────────────────────

export interface DialOptions {
  resolver?: Resolver;
  /** How long the TCP connection may take. Default 10 s. */
  connectTimeoutMs?: number;
  /**
   * TLS: a CA (PEM) the person gave for this source. When set it REPLACES Node's roots for this
   * connection (Node's `ca` option). Verification itself is never turned off.
   */
  tls?: { ca?: string };
}

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * A TCP connection to `host:port` under `policy`: resolved once, every address checked, connected
 * to a checked address (trying each in turn, as dual-stack fallback, never resolving again). The
 * database drivers run their own TLS over it with the hostname as the server name (`tls.ts`).
 */
export async function dialTcp(host: string, port: number, policy: AddressPolicy, opts: DialOptions & { signal?: AbortSignal } = {}): Promise<{ socket: Socket; target: DialTarget }> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new DialRefusedError('url_refused', `port ${port} is not a TCP port`);
  const target = await resolveTarget(host, policy, opts.resolver, opts.signal);
  let last: unknown = null;
  for (const a of target.addresses) {
    if (opts.signal?.aborted === true) throw abortError(opts.signal);
    const socket = netConnect({ host: a.address, port, family: a.family });
    socket.setNoDelay(true);
    let aborted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const done = (): void => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = (): void => {
          aborted = true;
          done();
          socket.destroy();
          reject(abortError(opts.signal as AbortSignal));
        };
        const timer = setTimeout(() => {
          done();
          socket.destroy();
          reject(new UpstreamCallError('timeout', false, `connecting to ${host}:${port} timed out`));
        }, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        socket.once('connect', () => {
          done();
          resolve();
        });
        socket.once('error', (err) => {
          done();
          reject(new UpstreamCallError('transport', true, `connecting to ${host}:${port} (${a.address}) failed: ${err.message}`));
        });
      });
    } catch (err) {
      if (aborted) throw err;
      last = err;
      continue;
    }
    // Belt and braces: the socket is where the check said.
    if (!isCheckedAddress(target, socket.remoteAddress)) {
      socket.destroy();
      throw new DialRefusedError('address_refused', `the connection to ${host} reached ${socket.remoteAddress ?? 'nothing'}, not a checked address`);
    }
    return { socket, target: { ...target, address: a.address, family: a.family, cls: a.cls } };
  }
  throw last instanceof Error ? last : new UpstreamCallError('transport', true, `connecting to ${host}:${port} failed`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

/** The subset of `RequestInit` the dialer accepts (enough for crew's callers and the MCP SDK). */
export interface DialRequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array | ArrayBuffer | null;
  signal?: AbortSignal | null;
  /** Ignored: a redirect is always refused. */
  redirect?: RequestRedirect;
}

export type DialFetch = (input: string | URL, init?: DialRequestInit) => Promise<Response>;

function bodyBytes(body: DialRequestInit['body']): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new DialRefusedError('url_refused', 'the dialer sends a string or bytes as a request body, nothing else');
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** zlib options as fetch (undici) uses them: a truncated or empty compressed body is not an error. */
const ZLIB_LENIENT = { flush: zlibConstants.Z_SYNC_FLUSH, finishFlush: zlibConstants.Z_SYNC_FLUSH };

/** The most content codings undone on one answer (fetch/undici's limit). */
const MAX_CODINGS = 5;

/** The first byte of a stream, put back unread; `null` = the stream ended empty. */
async function peekFirstByte(src: Readable): Promise<number | null> {
  for (;;) {
    const chunk = src.read() as Buffer | null;
    if (chunk !== null) {
      src.unshift(chunk);
      return chunk[0] ?? null;
    }
    if (src.readableEnded || src.destroyed) return null;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        src.off('readable', done);
        src.off('end', done);
        src.off('error', done);
        src.off('close', done);
        resolve();
      };
      src.on('readable', done);
      src.on('end', done);
      src.on('error', done);
      src.on('close', done);
    });
  }
}

/**
 * The body as the server meant it: each coding of `Content-Encoding` (gzip, x-gzip, deflate, br,
 * identity) is undone in reverse order, streamed with backpressure (a consumer that stops reading
 * stops the decoders), torn down together; callers still cap what they read. `deflate` is decoded
 * as fetch does: zlib-wrapped when its first byte says so, raw deflate otherwise.
 */
async function decoded(res: IncomingMessage): Promise<{ stream: Readable; encoded: boolean }> {
  const codings = String(res.headers['content-encoding'] ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity')
    .reverse();
  if (codings.length === 0) return { stream: res, encoded: false };
  if (codings.length > MAX_CODINGS) throw new UpstreamCallError('protocol', false, `the answer is encoded ${codings.length} times; crew decodes at most ${MAX_CODINGS} codings`);
  for (const c of codings) if (!['gzip', 'x-gzip', 'deflate', 'br'].includes(c)) throw new UpstreamCallError('protocol', false, `the answer is encoded as ${c}, which crew does not decode`);
  let current: Readable = res;
  for (const c of codings) {
    let decoder: Transform;
    if (c === 'gzip' || c === 'x-gzip') decoder = createGunzip(ZLIB_LENIENT);
    else if (c === 'br') decoder = createBrotliDecompress({ flush: zlibConstants.BROTLI_OPERATION_FLUSH, finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH });
    else {
      const first = await peekFirstByte(current);
      decoder = first !== null && (first & 0x0f) !== 0x08 ? createInflateRaw(ZLIB_LENIENT) : createInflate(ZLIB_LENIENT);
    }
    // pipeline: backpressure end to end, and an error or destroy anywhere tears every stage down.
    pipeline(current, decoder, () => undefined);
    current = decoder;
  }
  return { stream: current, encoded: true };
}

/** A transport failure as one non-empty message carrying its codes (dual-stack attempts end in an AggregateError). */
function transportError(host: string, err: unknown): unknown {
  if (err instanceof UpstreamCallError || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) return err;
  const parts: string[] = [];
  const add = (e: unknown): void => {
    const x = e as { code?: unknown; message?: unknown; errors?: unknown };
    if (Array.isArray(x?.errors)) for (const inner of x.errors) add(inner);
    const code = typeof x?.code === 'string' ? x.code : '';
    const msg = typeof x?.message === 'string' ? x.message : '';
    const text = [code, msg].filter((v) => v !== '' && !msg.includes(code)).join(' ') || msg || code;
    if (text !== '' && !parts.includes(text)) parts.push(text);
  };
  add(err);
  return new UpstreamCallError('transport', true, `connecting to ${host} failed: ${parts.join('; ') || 'the connection failed'}`);
}

/**
 * One HTTP(S) request under `policy`, answered as a WHATWG `Response` whose body streams (callers cap
 * it; nothing here buffers it whole) and is decoded (gzip, deflate, br). https always; http only where
 * {@link plaintextAllowed}. Any 3xx is a {@link DialRedirectRefusedError}; an upgrade (101) or a
 * connection that closes before an answer is a refusal, never a hang. The URL may carry no credentials.
 */
export async function dialFetch(input: string | URL, init: DialRequestInit = {}, policy: AddressPolicy, opts: DialOptions = {}): Promise<Response> {
  let url: URL;
  try {
    url = new URL(typeof input === 'string' ? input : input.href);
  } catch {
    throw new DialRefusedError('url_refused', `${String(input)} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DialRefusedError('url_refused', `${url.protocol} URLs are not dialled; https only`);
  if (url.username !== '' || url.password !== '') throw new DialRefusedError('url_refused', 'a URL carrying credentials is refused; reference a secret instead');
  const signal = init.signal ?? undefined;
  const target = await resolveTarget(url.hostname, policy, opts.resolver, signal);
  checkScheme(url, target, policy);
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((v, k) => {
    headers[k] = v;
  });
  // The Host header is the URL's own: Node derives the TLS server name from it, so a caller's Host
  // would move the certificate check off the name that was resolved and checked.
  delete headers['host'];
  headers['accept-encoding'] = 'gzip, deflate, br';
  const body = bodyBytes(init.body);
  if (body !== null) headers['content-length'] = String(body.byteLength);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'CONNECT') throw new DialRefusedError('url_refused', 'CONNECT is never sent');
  const pinnedLookup = (hostname: string, options: { all?: boolean } | undefined, cb: (...args: unknown[]) => void): void => {
    if (hostname !== target.hostname) {
      cb(new DialRefusedError('address_refused', `the connection asked to resolve ${hostname}, not the checked ${target.hostname}`));
      return;
    }
    if (options?.all === true) cb(null, target.addresses.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, target.address, target.family);
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  if (signal?.aborted === true) throw abortError(signal);
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    const settle = (err: unknown, r?: IncomingMessage): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err !== null) reject(err);
      else resolve(r as IncomingMessage);
    };
    const options: Parameters<typeof httpRequest>[1] & { autoSelectFamily: boolean } = {
      method,
      headers,
      agent: false,
      lookup: pinnedLookup as never,
      // Try every checked address in turn (Node's connect-multiple walks the whole list the lookup
      // answers, interleaving families), whatever the process default says.
      autoSelectFamily: true,
      // An IP-literal host is never looked up: it is dialled as written, which is what was checked.
      ...(url.protocol === 'https:' ? { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true, ...(opts.tls?.ca !== undefined ? { ca: opts.tls.ca } : {}) } : {}),
      timeout: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    };
    const req = send(url, options);
    function onAbort(): void {
      const err = abortError(signal as AbortSignal);
      req.destroy(err);
      settle(err);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('timeout', () => req.destroy(new UpstreamCallError('timeout', false, `connecting to ${url.host} timed out`)));
    req.once('error', (err) => settle(transportError(url.host, err)));
    // A protocol switch is never followed: the socket is closed and the call refused, not left pending.
    req.once('upgrade', (_r, socket) => {
      socket.destroy();
      settle(new UpstreamCallError('protocol', false, `${url.host} answered HTTP 101 (an upgrade); crew does not switch protocols`));
    });
    req.once('close', () => settle(new UpstreamCallError('transport', true, `the connection to ${url.host} closed before an answer`)));
    req.once('response', (r) => {
      req.setTimeout(0);
      // The pinned lookup decided the address; this confirms the socket agrees.
      if (!isCheckedAddress(target, r.socket?.remoteAddress)) {
        r.destroy();
        req.destroy();
        settle(new DialRefusedError('address_refused', `the response for ${url.host} came from ${r.socket?.remoteAddress ?? 'nowhere'}, not a checked address`));
        return;
      }
      settle(null, r);
    });
    req.end(body ?? undefined);
  });
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    const location = typeof res.headers.location === 'string' ? res.headers.location : null;
    res.destroy();
    // The Location is the upstream's text (it can carry anything): kept on the error for a caller that
    // shows a person, never in the message, which agents and health can see.
    throw new DialRedirectRefusedError(status, location, `${url.host} answered HTTP ${status} (a redirect); redirects are never followed`);
  }
  if (status < 200 || status > 599) {
    res.destroy();
    throw new UpstreamCallError('protocol', false, `${url.host} answered an HTTP status crew does not accept (${status})`);
  }
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const x of v) out.append(k, x);
    else if (v !== undefined) out.set(k, v);
  }
  if (NULL_BODY_STATUSES.has(status) || method === 'HEAD') {
    // No body is read: the connection is closed now, never left open on a body that never ends.
    res.destroy();
    return new Response(null, { status, statusText: res.statusMessage ?? '', headers: out });
  }
  let stream: Readable;
  // An abort while the decoders are being set up (a deflate answer's first byte may be slow to come)
  // tears the wire down at once; the body's own abort handling takes over after.
  const onEarlyAbort = (): void => {
    res.destroy(abortError(signal as AbortSignal));
  };
  signal?.addEventListener('abort', onEarlyAbort, { once: true });
  try {
    // An abort that landed between the answer and this point fired no listener (none was attached):
    // it is seen here, before anything waits on the body.
    if (signal !== undefined && isAborted(signal)) throw abortError(signal);
    const d = await decoded(res);
    if (signal !== undefined && isAborted(signal)) throw abortError(signal);
    stream = d.stream;
    if (d.encoded) {
      // The body below is the decoded one; its encoding and length are not the wire's any more.
      out.delete('content-encoding');
      out.delete('content-length');
    }
  } catch (err) {
    res.destroy();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onEarlyAbort);
  }
  return new Response(exposedBody(res, stream, signal), { status, statusText: res.statusMessage ?? '', headers: out });
}

/**
 * The body a caller reads. It pulls from the decoded stream on demand (nothing is queued ahead of the
 * reader), and an abort at any moment until the caller has read it all — even after the wire has
 * finished — errors it and tears down the wire and the decoders, as fetch does.
 */
function exposedBody(res: IncomingMessage, stream: Readable, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const reader = (Readable.toWeb(stream) as ReadableStream<Uint8Array>).getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let finished = false;
  const onAbort = (): void => {
    if (finished) return;
    finished = true;
    const err = abortError(signal as AbortSignal);
    res.destroy(err);
    stream.destroy(err);
    controller?.error(err);
    void reader.cancel(err).catch(() => undefined);
  };
  const finish = (): void => {
    finished = true;
    signal?.removeEventListener('abort', onAbort);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        if (signal === undefined) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      },
      async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (finished) return;
          if (done) {
            finish();
            c.close();
          } else c.enqueue(value);
        } catch (err) {
          if (finished) return;
          finish();
          c.error(err);
        }
      },
      cancel(reason) {
        finish();
        res.destroy();
        stream.destroy();
        return reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/** A `fetch`-shaped function bound to one source's policy: for the MCP SDK's transport, and callers. */
export function boundFetch(policy: AddressPolicy, opts: DialOptions = {}): DialFetch {
  return (input, init) => dialFetch(input, init ?? {}, policy, opts);
}
