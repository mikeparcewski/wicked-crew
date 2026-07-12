import { defineConfig } from 'astro/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shared chrome lives in the `wicked-web` package. Develop against the local
// source when it sits beside this repo (../../wicked-web from this site dir),
// otherwise (CI) resolve the installed github:mikeparcewski/wicked-web package
// from node_modules.
const localUI = fileURLToPath(new URL('../../wicked-web/src', import.meta.url));
const alias = existsSync(localUI) ? { 'wicked-web': localUI } : {};

// https://astro.build/config
export default defineConfig({
  // wc.wickedagile.com isn't live yet — serve from GitHub Pages for now.
  // Restore site:'https://wc.wickedagile.com' + base:'/' when the subdomain is up.
  site: 'https://mikeparcewski.github.io',
  base: '/wicked-crew',
  output: 'static',
  vite: { resolve: { alias } },
});
