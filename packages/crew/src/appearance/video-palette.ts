/**
 * The demo video's palette, taken from the operator's studio skin (operator, 2026-10-14: "the video color scheme
 * should take the lead from the wicked skin by default"). The skin is the `studio.appearance` blob crew stores
 * verbatim (crew#323): a theme id and an HSL accent. Each theme's ground and ink are studio's own token values
 * (`src/styles/tokens.css` and `src/styles/themes/*.css`; an alpha ink is composited onto its canvas), and the accent gets the same per-theme adjustment the
 * theme applies, raised or lowered until it reads on the canvas (≥ 3:1). Renderers (garden's demo stage,
 * interactive's re-cuts) read this; an explicit brand colour of a storyline or a custom video style overrides it.
 */

import type { VideoPalette, VideoPaletteResponse } from '../core/types.js';

type ThemeId = 'dark' | 'light' | 'wicked-light' | 'wicked-dark';

interface Ground {
  canvas: string;
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  line: string;
  /** The theme's accent derivation from the stored HSL (studio's `--accent` for that theme). */
  accent: (h: number, s: number, l: number) => [number, number, number];
}

const clampPct = (v: number): number => Math.min(100, Math.max(0, v));

const THEMES: Record<ThemeId, Ground> = {
  dark: { canvas: '#0a0c11', surface: '#151922', ink: '#f4f6fb', ink2: '#c5cad4', muted: '#9a9ea7', line: '#242832', accent: (h, s, l) => [h, s, l] },
  light: { canvas: '#f4f6fa', surface: '#ffffff', ink: '#0b0f1a', ink2: '#2d323e', muted: '#4e525d', line: '#d9dbe1', accent: (h, s, l) => [h, s * 0.8, l - 24] },
  'wicked-light': { canvas: '#e8edf1', surface: '#ffffff', ink: '#0b0f14', ink2: '#1e262e', muted: '#38434e', line: '#dbe3e9', accent: (h, s, l) => [h, s, l] },
  'wicked-dark': { canvas: '#0d1117', surface: '#1b222e', ink: '#e6edf3', ink2: '#cdd6df', muted: '#aeb9c4', line: '#2a3442', accent: (h, s, l) => [h, s, l + 40] },
};

/** Studio's defaults: a stored blob without a theme is `dark` (tokens.css); no blob at all is a new install,
 *  which studio shows as wicked-light with the harbor accent (`NEW_INSTALL_APPEARANCE`). */
const DEFAULT_ACCENT = { h: 230, s: 74, l: 68 };
const NEW_INSTALL = { theme: 'wicked-light' as ThemeId, h: 200, s: 47, l: 25 };

/** The skin's typeface (`--font-sans` in every theme). */
const FONT = 'Archivo';

function hslToHex(h: number, s: number, l: number): string {
  const sat = clampPct(s) / 100;
  const lig = clampPct(l) / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number): number => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** The accent, moved in lightness away from the canvas until it reads on it (≥ 3:1, non-text contrast). */
function readableAccent(h: number, s: number, l: number, canvas: string): string {
  const darkCanvas = luminance(canvas) < 0.2;
  let lig = clampPct(l);
  let hex = hslToHex(h, s, lig);
  for (let i = 0; i < 100 && contrast(hex, canvas) < 3; i += 1) {
    lig = clampPct(lig + (darkCanvas ? 1 : -1));
    hex = hslToHex(h, s, lig);
  }
  return hex;
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

const isTheme = (v: unknown): v is ThemeId => v === 'dark' || v === 'light' || v === 'wicked-light' || v === 'wicked-dark';

/** The video palette for a stored `studio.appearance` value (or none stored). */
export function videoPalette(appearance: unknown): VideoPaletteResponse {
  const stored = typeof appearance === 'object' && appearance !== null && !Array.isArray(appearance) ? (appearance as Record<string, unknown>) : null;
  const theme: ThemeId = stored === null ? NEW_INSTALL.theme : isTheme(stored['theme']) ? stored['theme'] : 'dark';
  const base = stored === null ? NEW_INSTALL : DEFAULT_ACCENT;
  const h = num(stored?.['accent_h'], 0, 360, base.h);
  const s = num(stored?.['accent_s'], 0, 100, base.s);
  const l = num(stored?.['accent_l'], 0, 100, base.l);
  const g = THEMES[theme];
  const [ah, as, al] = g.accent(h, s, l);
  const palette: VideoPalette = {
    canvas: g.canvas,
    surface: g.surface,
    ink: g.ink,
    ink2: g.ink2,
    muted: g.muted,
    line: g.line,
    accent: readableAccent(ah, as, al, g.canvas),
    font: FONT,
    scheme: luminance(g.canvas) < 0.2 ? 'dark' : 'light',
  };
  return { source: stored === null ? 'studio-default' : 'studio-skin', theme, palette };
}
