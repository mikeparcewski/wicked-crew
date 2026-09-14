// The versions of THIS install, in one place (crew#551 / crew#493, F-RC1-044, F-003 — FIX-IT-ALL
// L10-1). `wicked-crew --version` prints them; `GET /api/v1/diagnostics.components` reports the
// same three for the daemon that is actually serving a port — which may be a DIFFERENT install
// (an `npx wicked-crew` next to a global one, crew#499), so the CLI answer is scoped to the code
// that is running and never consults a socket.
//
// Nothing here is a new reader: the three joins reuse the readers that already existed unjoined —
// `crewPackageVersion()` (the origin stamp on dead-letter records), `installedPackageVersion()`
// (the diagnostics route's `components.coreTs`, which walks the resolver's candidate dirs because
// wicked-core-ts's exports map refuses `require.resolve` on `/package.json`) and
// `readStudioBundleVersion()` (the bundled studio's `testid-inventory.json`, TH-13) at the root
// the daemon serves (`defaultStudioRoot()`).
import { installedPackageVersion, readStudioBundleVersion } from '../api/diagnostics.js';
import { defaultStudioRoot } from '../api/server.js';
import { crewPackageVersion } from '../cli/governance.js';

/** The three components a crew install is made of; `null` = not present in this install. */
export interface InstalledVersions {
  /** This package's own version. */
  crew: string;
  /** The wicked-core-ts engine binding resolvable from this install, or `null`. */
  coreTs: string | null;
  /** The studio bundle at `dist/studio`, or `null` for a headless (unbundled) install. */
  studioBundle: string | null;
}

/** Read the three versions of THIS install. Pure file reads; no daemon, no socket. */
export function installedVersions(): InstalledVersions {
  return {
    crew: crewPackageVersion(),
    coreTs: installedPackageVersion('wicked-core-ts'),
    studioBundle: readStudioBundleVersion(defaultStudioRoot()),
  };
}

/**
 * The lines `wicked-crew --version` prints — one per component, `<name> <version>`, with
 * `unknown` for an unresolvable engine binding and `none` for an unbundled studio.
 */
export function versionLines(v: InstalledVersions = installedVersions()): string[] {
  return [
    `wicked-crew ${v.crew}`,
    `wicked-core-ts ${v.coreTs ?? 'unknown'}`,
    `wicked-studio ${v.studioBundle ?? 'none'}`,
  ];
}
