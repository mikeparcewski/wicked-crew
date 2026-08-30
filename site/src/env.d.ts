/// <reference types="astro/client" />

/**
 * Build-time constant injected by astro.config.mjs (vite define) from
 * packages/crew/package.json — the published `wicked-crew` npm manifest.
 * Keeps the site's install-CTA version stamp true by construction (DT-7).
 */
declare const __WICKED_CREW_VERSION__: string;
