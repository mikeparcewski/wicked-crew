// DES-CHAT-ARTIFACTS-001 §13 A1: the 48-message eval corpus is a test asset A2 runs against real seats. This keeps
// it the shape the design says (8 intents, each 3 with an artifact open and 3 without), every ref an artifact ref
// with a fixture, every expectation the shape its intent needs, and each fixture readable by the same outline the
// per-turn block hands a seat (so "what does slide 4 say?" has a slide 4).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { anchorTexts, outlineOf } from '../src/api/artifact-outline.js';
import { parseArtifactRef } from '../src/api/chat-context.js';

const DIR = join(__dirname, 'fixtures', 'chat-artifacts-corpus');

interface Message {
  id: string;
  intent: string;
  open: string | null;
  text: string;
  anchors?: string[];
  madeInChat?: string[];
  expect: { proposal: null | { kind: 'entry' | 'refine' | 'theme'; entry?: string; refine?: string; changes?: string[]; url?: string }; reply?: string };
}
interface Corpus {
  intents: string[];
  artifacts: Record<string, { kind: string; version: number; head: number; fixture: string }>;
  runs: Record<string, string>;
  messages: Message[];
}

const corpus = JSON.parse(readFileSync(join(DIR, 'corpus.json'), 'utf8')) as Corpus;

describe('chat artifacts corpus (A1 asset, A2 runs it)', () => {
  it('has 48 messages: 8 intents, each 3 with an artifact open and 3 without, unique ids', () => {
    expect(corpus.intents).toEqual(['information', 'make', 'refine', 'theme', 'demo', 'ambiguous', 'cant', 'code-change']);
    expect(corpus.messages).toHaveLength(48);
    expect(new Set(corpus.messages.map((m) => m.id)).size).toBe(48);
    for (const intent of corpus.intents) {
      const of = corpus.messages.filter((m) => m.intent === intent);
      expect(of.filter((m) => m.open !== null), intent).toHaveLength(3);
      expect(of.filter((m) => m.open === null), intent).toHaveLength(3);
    }
  });

  it('names only artifact refs that have a fixture, and selected parts that exist in it', () => {
    for (const m of corpus.messages) {
      for (const ref of [...(m.open !== null ? [m.open] : []), ...(m.madeInChat ?? [])]) {
        expect(parseArtifactRef(ref), `${m.id}: ${ref}`).not.toBeNull();
        expect(corpus.artifacts[ref], `${m.id}: ${ref}`).toBeDefined();
      }
      if (m.anchors !== undefined) {
        const html = readFileSync(join(DIR, corpus.artifacts[m.open!]!.fixture), 'utf8');
        for (const a of anchorTexts(html, m.anchors)) expect(a.found, `${m.id}: ${a.wid}`).toBe(true);
      }
    }
  });

  it('expects what each intent needs: no proposal where nothing is made, the right kind where something is', () => {
    for (const m of corpus.messages) {
      const p = m.expect.proposal;
      if (['information', 'ambiguous', 'cant', 'code-change'].includes(m.intent)) expect(p, m.id).toBeNull();
      if (m.intent === 'make') expect(p?.kind, m.id).toBe('entry');
      if (m.intent === 'refine') {
        expect(p?.kind, m.id).toBe('refine');
        // A refine targets the open artifact, or one this chat made.
        expect([m.open, ...(m.madeInChat ?? [])], m.id).toContain(p?.refine);
      }
      if (m.intent === 'theme') expect(p?.kind === 'theme' && (p.changes?.length ?? 0) > 0, m.id).toBe(true);
      if (m.intent === 'demo') {
        if (p === null) expect(m.expect.reply, m.id).toBeDefined();
        else {
          expect(p.entry, m.id).toBe('demo-video');
          // A demo's address comes from the person's words, never the model (DES §10).
          expect(m.text, m.id).toContain(p.url!);
        }
      }
      if (p === null) expect(m.expect.reply, m.id).toBeDefined();
    }
  });

  it('gives each fixture an outline the per-turn block can number (slide 4 of the deck is its timeline)', () => {
    for (const [ref, a] of Object.entries(corpus.artifacts)) {
      const o = outlineOf(readFileSync(join(DIR, a.fixture), 'utf8'));
      expect(o.items.length, ref).toBeGreaterThan(0);
      expect(o.title, ref).not.toBeNull();
    }
    const deck = outlineOf(readFileSync(join(DIR, corpus.artifacts['mikes/domain-coverage-deck']!.fixture), 'utf8'));
    expect(deck.items[3]).toMatchObject({ n: 4, unit: 'slide' });
    expect(deck.items[3]!.text).toContain('23% → 61% in run 29bbbfb1');
    for (const id of Object.keys(corpus.runs)) expect(deck.items.map((i) => i.text).join(' ')).toContain(id);
  });
});
