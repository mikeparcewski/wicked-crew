// The demo video's palette from the studio skin (operator 2026-10-14): two skins give different colours, no skin gives
// studio's new-install look, and every theme's text and accent stay readable on its canvas.

import { describe, expect, it } from 'vitest';

import { contrast, videoPalette } from '../src/appearance/video-palette.js';

const skin = (theme: string, h = 200, s = 47, l = 25): Record<string, unknown> => ({ theme, accent_h: h, accent_s: s, accent_l: l, logo_url: null, site_name: null });

describe('the video palette follows the studio skin', () => {
  it('two different skins give different card colours', () => {
    const a = videoPalette(skin('wicked-light')).palette;
    const b = videoPalette(skin('wicked-dark', 12, 80, 50)).palette;
    expect(a.canvas).not.toBe(b.canvas);
    expect(a.accent).not.toBe(b.accent);
    expect([a.scheme, b.scheme]).toEqual(['light', 'dark']);
  });

  it('the accent is the skin\'s own hue, not a fixed red', () => {
    const green = videoPalette(skin('light', 140, 60, 70)).palette.accent;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
    expect(g!).toBeGreaterThan(r!);
    expect(g!).toBeGreaterThan(b!);
  });

  it('no stored skin is studio\'s new-install look (wicked-light, harbor accent)', () => {
    const r = videoPalette(undefined);
    expect(r.source).toBe('studio-default');
    expect(r.theme).toBe('wicked-light');
    expect(r.palette.accent).toBe('#224a5e');
  });

  it.each(['dark', 'light', 'wicked-light', 'wicked-dark'])('%s: ink >= 7:1, muted >= 4.5:1 and accent >= 3:1 on the canvas, whatever the accent', (theme) => {
    for (const [h, s, l] of [[0, 100, 50], [60, 100, 90], [230, 74, 68], [200, 47, 25], [0, 0, 5], [0, 0, 98]]) {
      const p = videoPalette(skin(theme, h, s, l)).palette;
      expect(contrast(p.ink, p.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.muted, p.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.accent, p.canvas), `${theme} ${h}/${s}/${l} → ${p.accent}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('a malformed blob reads as studio does: theme dark, default accent', () => {
    const r = videoPalette({ theme: 'neon', accent_h: 'x' });
    expect(r.theme).toBe('dark');
    expect(r.source).toBe('studio-skin');
  });
});
