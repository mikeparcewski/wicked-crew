/**
 * The learned topics of a registered repository (DES-learn-workflow §2, §6), read from its checkout's
 * `.wicked/knowledge/<slug>/` (topic.json + claims.jsonl): what studio's learn page shows — each
 * topic's claim counts by status and how stale its active claims are. Read-only and bounded: at
 * most MAX_TOPICS topics and MAX_CLAIMS_BYTES of claims per topic; a malformed file is reported on
 * the topic (`problem`), never thrown.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LearnTopic } from 'wicked-crew-api-types';
import { LEARN_SLUG } from './schedule-store.js';

export type { LearnTopic };

const MAX_TOPICS = 200;
const MAX_CLAIMS_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;

function iso(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** One topic's summary. `staleAfterDays`: an active claim not re-verified for longer counts as stale. */
export async function readTopic(dir: string, slug: string, staleAfterDays: number, now: Date): Promise<LearnTopic> {
  const topic: LearnTopic = {
    slug,
    title: slug,
    kind: 'topic',
    refreshedAt: null,
    claims: { active: 0, superseded: 0, contradicted: 0, retired: 0 },
    oldestVerifiedAt: null,
    staleActive: 0,
    sources: 0,
    problem: null,
  };
  try {
    const meta = JSON.parse(await readFile(join(dir, 'topic.json'), 'utf8')) as Record<string, unknown>;
    if (typeof meta['title'] === 'string' && meta['title'].trim() !== '') topic.title = meta['title'];
    if (meta['kind'] === 'event') topic.kind = 'event';
    topic.refreshedAt = iso(meta['refreshed_at']) ?? iso(meta['created_at']);
  } catch {
    topic.problem = 'topic.json is missing or does not parse';
  }
  try {
    const path = join(dir, 'claims.jsonl');
    if ((await stat(path)).size > MAX_CLAIMS_BYTES) throw new Error('too large');
    const urls = new Set<string>();
    let oldest: number | null = null;
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (line.trim() === '') continue;
      let c: Record<string, unknown>;
      try {
        c = JSON.parse(line) as Record<string, unknown>;
      } catch {
        topic.problem ??= 'claims.jsonl has a line that does not parse';
        continue;
      }
      const status = c['status'];
      if (status === 'active' || status === 'superseded' || status === 'contradicted' || status === 'retired') topic.claims[status] += 1;
      if (Array.isArray(c['sources'])) for (const s of c['sources']) if (s && typeof (s as { url?: unknown }).url === 'string') urls.add((s as { url: string }).url);
      if (status !== 'active') continue;
      const verified = iso(c['last_verified']) ?? iso(c['first_seen']);
      const t = verified === null ? null : Date.parse(verified);
      if (t !== null && (oldest === null || t < oldest)) oldest = t;
      if (t === null || now.getTime() - t > staleAfterDays * DAY_MS) topic.staleActive += 1;
    }
    topic.sources = urls.size;
    topic.oldestVerifiedAt = oldest === null ? null : new Date(oldest).toISOString();
  } catch {
    topic.problem ??= 'claims.jsonl is missing or unreadable';
  }
  return topic;
}

/** Every topic under `<root>/.wicked/knowledge/`, sorted by slug. An absent dir is an empty list. */
export async function readTopics(root: string, staleAfterDays: (slug: string) => number, now: Date): Promise<LearnTopic[]> {
  const base = join(root, '.wicked', 'knowledge');
  let names: string[];
  try {
    names = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory() && LEARN_SLUG.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  names.sort();
  return Promise.all(names.slice(0, MAX_TOPICS).map((slug) => readTopic(join(base, slug), slug, staleAfterDays(slug), now)));
}
