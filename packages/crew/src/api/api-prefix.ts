/**
 * The single source of truth for the HTTP API's version prefix (FINDING-006).
 *
 * Lives in its own leaf module — not in routes.ts — on purpose. Both `routes.ts` (which mounts
 * every path under this prefix) and `unit-output.ts` (which builds an operator-facing evidence URL
 * that must match those paths) need this constant. Exporting it from routes.ts, as the first cut
 * did (Copilot review on #217), created a cycle: routes.ts imports unit-output.ts, so importing
 * API_PREFIX back from routes.ts made unit-output.ts pull in routes.ts's whole module
 * initialization (which reads package.json) and risked an ESM temporal-dead-zone trap. A leaf
 * constant that neither side's logic depends on breaks that cycle cleanly.
 */
export const API_PREFIX = '/api/v1';
