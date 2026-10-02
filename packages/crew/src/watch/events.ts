/**
 * The watch registry's bus facts (DES-TRIGGER-REGISTRY-001 §4.5, TR-W5a).
 *
 * One owner: crew's watch registry. The event types carry the grammar's bare `crew` segment
 * (`wicked.crew.watch_finding.raised`); the DOMAIN COLUMN is the product-scoped plugin name, as
 * `projects/events.ts` spells it. Declared as `const`s in a file the core event-catalog generator
 * scans (`gen_event_catalog.py` seam list, TR-W3), so the catalog and the emitter cannot drift.
 */

/** A check produced a finding, a flag or a proposal. */
export const WATCH_FINDING_RAISED = 'wicked.crew.watch_finding.raised';
/** The condition resolved, the operator dismissed it, or a roll-up replaced it. */
export const WATCH_FINDING_CLEARED = 'wicked.crew.watch_finding.cleared';

/** The prefix both types share: the `/ws` relay's tap and the boot hydrate read it. */
export const WATCH_FINDING_PREFIX = 'wicked.crew.watch_finding.';

/** Crew's bus domain column (the `projects/events.ts` precedent). */
export const WATCH_BUS_DOMAIN = 'wicked-crew';
export const WATCH_BUS_SUBDOMAIN = 'watch';
export const WATCH_PRODUCER = 'wicked-crew';

/** The ONE envelope type the relay puts on `/ws` (api-types `WatchEventFrame`). */
export const WATCH_EVENT_FRAME = 'watchEvent';
