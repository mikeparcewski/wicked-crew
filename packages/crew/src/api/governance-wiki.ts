/**
 * The `/api/v1/governance/wiki/*` surface (wiki-mgmt) — the management wire for the graph-backed
 * architecture wiki, so the wiki is VISIBLE (not just queryable): a scoreboard that tells a
 * populated wiki from an ingested-once-and-decaying one, and a meta probe cheap enough for the
 * UI to call on mount so an empty store shows an honest "nothing seeded — here's the runbook"
 * instead of a blank table.
 *
 * Thin by design, like `campaigns/routes.ts`: the scoreboard is computed by wicked-core's
 * governance layer (`wicked-governance::scoreboard`, read-only `open_store_ro` — safe beside the
 * live single-writer daemon); the daemon keeps no shadow wiki state. Error posture mirrors the
 * campaign surface: a build whose engine addon lacks the `governanceScoreboard` binding answers
 * 501 (`GovernanceScoreboardUnsupportedError` — "upgrade the engine"), never 400 ("fix your
 * request").
 *
 * Rule/ruleset BROWSE and RETIRE deliberately live elsewhere — this module adds no second door:
 * `GET /governance/rules` (facet-filterable, retired rows flagged) is the browse surface and
 * `DELETE /governance/rules/:id` (retire-not-delete, FINDING-038) is the kill switch, both in
 * `api/routes.ts`.
 */

import type { FastifyInstance } from 'fastify';

import { GovernanceScoreboardUnsupportedError, type CoreAdapter } from '../core/adapter.js';
import type { GovernanceWikiMeta } from '../core/types.js';
import { API_PREFIX } from './api-prefix.js';

const V = API_PREFIX;

/**
 * The authoring guide the honest empty state points at: the AW-13 seed runbook — frontmatter
 * conventions, the `seed_wiki.py` driver, and the `wicked-core rules` ingest/fanout/relink CLIs.
 */
export const WIKI_AUTHORING_DOC =
  'https://github.com/mikeparcewski/wicked-core/blob/main/crates/wicked-governance/seed/README.md';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerGovernanceWikiRoutes(app: FastifyInstance, adapter: CoreAdapter): void {
  // The AW-23 population/connection scoreboard. `?docsRoot=` is the OPTIONAL docs root the
  // typing half needs (the same directory `rules ingest --dir` consumed — enforcement_class
  // lives in doc frontmatter, never on the rule node); omitted, the scoreboard still answers
  // 200 with `typing.available: false` and the reason in-band — a wiki with no local docs
  // checkout is a normal deployment, not an error.
  app.get(
    `${V}/governance/wiki/scoreboard`,
    {
      config: {
        manifest: {
          responseType: '{ scoreboard: GovernanceScoreboard }',
          // 501: the installed engine addon predates the governanceScoreboard binding
          // (wicked-core-ts < 0.7.4) — upgrade the engine, the request was already correct.
          statusCodes: [200, 500, 501],
        },
      },
    },
    async (req, reply) => {
      // Fastify parses a repeated `?docsRoot=a&docsRoot=b` into an array — take the first, and
      // TRIM so a whitespace-only value means "no docs root" rather than a doomed doc scan.
      const raw = (req.query as { docsRoot?: string | string[] }).docsRoot;
      const first = Array.isArray(raw) ? raw[0] : raw;
      const docsRoot = first?.trim() || undefined;
      try {
        const scoreboard = await adapter.governanceScoreboard(docsRoot);
        return { scoreboard };
      } catch (err) {
        if (err instanceof GovernanceScoreboardUnsupportedError) {
          return reply.code(501).send({ error: err.message });
        }
        // An engine/store failure is OURS, not the caller's — there is nothing to fix in a
        // bare GET, so nothing here maps to 400.
        return reply.code(500).send({ error: message(err) });
      }
    },
  );

  // The wiki's honest empty-state signal. Works on EVERY addon (listConformanceRules is a
  // required binding since crew#40), so the UI can always distinguish "nothing seeded — run the
  // seed runbook" from "the engine can't tell me": `ruleset_count` is `null` (never a fabricated
  // 0) on a build without the listRuleSets binding, and `scoreboard_available` says up front
  // whether the scoreboard route will answer 200 here.
  app.get(
    `${V}/governance/wiki/meta`,
    {
      config: {
        manifest: {
          responseType: '{ meta: GovernanceWikiMeta }',
          statusCodes: [200],
        },
      },
    },
    // Wrapped per crew house style — campaigns/rules/scoreboard all wrap, and studio's
    // Wiki page reads `body.meta` (a bare seeded:false would read as "cannot tell").
    async (): Promise<{ meta: GovernanceWikiMeta }> => {
      // NOTE: pre-0.7.4 addons funnel listConformanceRules through recall, which skips retired
      // rows — so `rule_count` counts the LISTABLE rules. That is the right number for "is
      // anything here": a store holding only retired rules has nothing recallable to show.
      const rules = await adapter.listConformanceRules();
      const rulesetCount = await adapter.countRuleSets();
      return {
        meta: {
          seeded: rules.length > 0 || (rulesetCount ?? 0) > 0,
          ruleset_count: rulesetCount,
          rule_count: rules.length,
          scoreboard_available: adapter.wikiScoreboardSupported(),
          doc: WIKI_AUTHORING_DOC,
        },
      };
    },
  );
}
