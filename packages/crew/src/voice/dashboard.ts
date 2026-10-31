/**
 * The voice dashboard, saved per person (operator 2026-10-31: "users can create, add and remove widgets on the
 * voice dashboard").
 *
 * Studio frames voice mode's transcript with widgets. Each widget is a plugin that registers one section in the
 * `voice-dashboard` panel slot, the same `panels[]` manifest shape as a run plugin's `run.details` sections. The
 * built-in ones ship in studio's bundle; a person makes more with the metric-widget builder, and those are
 * USER PLUGINS: declarative manifests (no code, nothing framed) that read one field of `GET /system` or
 * `GET /diagnostics` and show it as a number or a chart. This store keeps, per actor id, which widgets are on the
 * dashboard in which order (`layout`) and the user plugins that person made (`widgets`).
 *
 * ONE file, `<state home>/daemon-voice-dashboard.json`, under the `daemon-` prefix the state-home fence already
 * classifies (as `daemon-editors.json`). Written whole through a temp file and a rename.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const VOICE_DASHBOARD_FILENAME = 'daemon-voice-dashboard.json';
export const VOICE_DASHBOARD_SLOT = 'voice-dashboard';
export const VOICE_DASHBOARD_MAX_LAYOUT = 24;
export const VOICE_DASHBOARD_MAX_WIDGETS = 16;

const plainTitle = z.string().trim().min(1).max(40).refine((s) => !/[\r\n<>]/u.test(s), 'no line breaks or angle brackets');

/** A field path into the source's JSON: `infra[key=load].details.load1`, `runs.length`, `toReview`. */
export const METRIC_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:-]{1,64}\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:-]{1,64}\])?){0,7}$/u;

export const VoicePanelDeclSchema = z.object({
  slot: z.literal(VOICE_DASHBOARD_SLOT),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
  title: plainTitle,
  order: z.number().int().min(1).max(99),
}).strict();

/** A user-made metric widget: a declarative plugin manifest (api-types `VoiceWidgetManifest`). */
export const VoiceWidgetManifestSchema = z.object({
  id: z.string().regex(/^user\.[a-z0-9][a-z0-9-]{0,39}$/u, 'a user widget id is `user.<slug>`'),
  title: plainTitle,
  version: z.literal(1),
  kind: z.literal('metric'),
  panels: z.array(VoicePanelDeclSchema).length(1),
  metric: z.object({
    source: z.enum(['system', 'diagnostics']),
    path: z.string().max(160).regex(METRIC_PATH, 'a field path like `infra[key=load].details.load1`'),
    display: z.enum(['number', 'chart']),
    unit: z.string().trim().max(12).optional(),
  }).strict(),
  createdAt: z.string().max(40).optional(),
}).strict();

const LAYOUT_ID = /^(?:builtin|user)\.[a-z0-9][a-z0-9-]{0,39}$/u;

export const PutVoiceDashboardSchema = z.object({
  layout: z.array(z.string().regex(LAYOUT_ID)).max(VOICE_DASHBOARD_MAX_LAYOUT),
  widgets: z.array(VoiceWidgetManifestSchema).max(VOICE_DASHBOARD_MAX_WIDGETS),
}).strict().refine(
  (b) => new Set(b.widgets.map((w) => w.id)).size === b.widgets.length,
  { message: 'two user widgets share an id', path: ['widgets'] },
).refine(
  (b) => new Set(b.layout).size === b.layout.length,
  { message: 'a widget is on the layout twice', path: ['layout'] },
).refine(
  (b) => b.layout.every((id) => id.startsWith('builtin.') || b.widgets.some((w) => w.id === id)),
  { message: 'the layout names a user widget that is not in `widgets`', path: ['layout'] },
);

export type VoiceWidgetManifest = z.infer<typeof VoiceWidgetManifestSchema>;
export type PutVoiceDashboardBody = z.infer<typeof PutVoiceDashboardSchema>;

/** `GET /voice/dashboard` (api-types `VoiceDashboard`): `layout: null` = never saved (studio's default). */
export interface VoiceDashboardBody {
  layout: string[] | null;
  widgets: VoiceWidgetManifest[];
  updatedAt: string | null;
}

interface FileShape {
  version: 1;
  byActor: Record<string, { layout: string[]; widgets: VoiceWidgetManifest[]; updatedAt: string }>;
}

export class VoiceDashboardStore {
  constructor(private readonly path: string) {}

  static under(stateHome: string): VoiceDashboardStore {
    return new VoiceDashboardStore(join(stateHome, VOICE_DASHBOARD_FILENAME));
  }

  private read(): FileShape {
    if (!existsSync(this.path)) return { version: 1, byActor: {} };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      const byActor: FileShape['byActor'] = {};
      for (const [actor, v] of Object.entries(raw.byActor ?? {})) {
        // A record that no longer validates is dropped whole, never half-read.
        const ok = PutVoiceDashboardSchema.safeParse({ layout: v?.layout, widgets: v?.widgets });
        if (ok.success) byActor[actor] = { ...ok.data, updatedAt: typeof v?.updatedAt === 'string' ? v.updatedAt : new Date(0).toISOString() };
      }
      return { version: 1, byActor };
    } catch {
      return { version: 1, byActor: {} };
    }
  }

  get(actorId: string): VoiceDashboardBody {
    const mine = this.read().byActor[actorId];
    return mine === undefined ? { layout: null, widgets: [], updatedAt: null } : { layout: mine.layout, widgets: mine.widgets, updatedAt: mine.updatedAt };
  }

  put(actorId: string, body: PutVoiceDashboardBody): VoiceDashboardBody {
    const file = this.read();
    const updatedAt = new Date().toISOString();
    file.byActor[actorId] = { layout: body.layout, widgets: body.widgets, updatedAt };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(tmp, this.path);
    return { layout: body.layout, widgets: body.widgets, updatedAt };
  }
}
