/**
 * The learned topics of a registered repository (DES-learn-workflow §2, §6), read from its checkout's
 * `.wicked/knowledge/<slug>/` (topic.json + claims.jsonl): what studio's learn page shows — each
 * topic's claim counts by status and how stale its active claims are. Read-only and bounded: at
 * most MAX_TOPICS topics and MAX_CLAIMS_BYTES of claims per topic; a malformed file is reported on
 * the topic (`problem`), never thrown.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { execCapped } from '../core/exec.js';
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
/** Where a topic's files are read from: the checkout's working tree, or a git ref (what MERGED). */
export interface TopicSource {
  /** The topic directories under `.wicked/knowledge/`. */
  slugs(): Promise<string[]>;
  /** One file's text, or `null` when absent. */
  read(slug: string, file: 'topic.json' | 'claims.jsonl'): Promise<string | null>;
}

export function treeSource(root: string): TopicSource {
  const base = join(root, '.wicked', 'knowledge');
  return {
    slugs: async () => {
      try {
        return (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
    },
    read: async (slug, file) => {
      const path = join(base, slug, file);
      try {
        if ((await stat(path)).size > MAX_CLAIMS_BYTES) return null;
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** The topics as they are at a git `ref` of the checkout (e.g. `origin/main`, what the learn tick indexes). */
export function refSource(root: string, ref: string): TopicSource {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      return (await execCapped('git', ['-C', root, ...args], { timeout: 10_000, maxBuffer: MAX_CLAIMS_BYTES })).stdout;
    } catch {
      return null;
    }
  };
  return {
    slugs: async () => {
      // `<mode> <type> <oid>\t<name>` — only tree entries are topics (codex r1: a tracked file is not).
      const out = await git(['ls-tree', `${ref}:.wicked/knowledge`]);
      if (out === null) return [];
      return out.split('\n').flatMap((line) => {
        const m = /^\d+ tree [0-9a-f]+\t(.+)$/.exec(line.trim());
        return m !== null ? [m[1]!] : [];
      });
    },
    read: (slug, file) => git(['show', `${ref}:.wicked/knowledge/${slug}/${file}`]),
  };
}

export async function readTopic(src: TopicSource, slug: string, staleAfterDays: number, now: Date): Promise<LearnTopic> {
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
    const raw = await src.read(slug, 'topic.json');
    if (raw === null) throw new Error('absent');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (typeof meta['title'] === 'string' && meta['title'].trim() !== '') topic.title = meta['title'];
    if (meta['kind'] === 'event') topic.kind = 'event';
    topic.refreshedAt = iso(meta['refreshed_at']) ?? iso(meta['created_at']);
  } catch {
    topic.problem = 'topic.json is missing or does not parse';
  }
  try {
    const text = await src.read(slug, 'claims.jsonl');
    if (text === null) throw new Error('absent or too large');
    const urls = new Set<string>();
    let oldest: number | null = null;
    for (const line of text.split('\n')) {
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

/** Every topic in `src`, sorted by slug. No knowledge dir is an empty list. */
export async function readTopics(src: TopicSource, staleAfterDays: (slug: string) => number, now: Date): Promise<LearnTopic[]> {
  const names = (await src.slugs()).filter((n) => LEARN_SLUG.test(n)).sort();
  return Promise.all(names.slice(0, MAX_TOPICS).map((slug) => readTopic(src, slug, staleAfterDays(slug), now)));
}

/** What MERGED (F-LEARN-4): `origin/<default>` when the checkout has that ref (the learn tick fetches
 *  it each minute and indexes the same tree), else the working tree (a repository with no remote). */
export async function mergedSource(root: string, defaultBranch: string): Promise<TopicSource> {
  const ref = `origin/${defaultBranch || 'main'}`;
  try {
    await execCapped('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeout: 5_000 });
    return refSource(root, ref);
  } catch {
    return treeSource(root);
  }
}
