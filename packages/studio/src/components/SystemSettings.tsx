import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { SystemSettings as Settings } from '../api/types.js';

interface SettingRowProps {
  label: string;
  description: string;
  children: React.ReactNode;
}

function SettingRow({ label, description, children }: SettingRowProps): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SystemSettings(): React.ReactElement {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState<Partial<Settings>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings()
      .then(({ settings: s }) => setSettings(s))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  function patch<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setDirty((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (Object.keys(dirty).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const { settings: next } = await api.updateSettings(dirty);
      setSettings(next);
      setDirty({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const merged: Settings = { graphNodeLimit: 150, ...settings, ...dirty };
  const hasDirty = Object.keys(dirty).length > 0;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-gray-900">System</h1>
        <p className="text-sm text-gray-500 mt-1">
          Runtime tunables persisted to <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">~/.config/wicked-core/settings.json</code>.
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded bg-red-50 border border-red-200 text-xs text-red-700">{error}</div>
      )}

      {/* Graph section */}
      <section className="bg-white border border-gray-200 rounded-xl px-5 mb-6">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-4 pb-2">Code Graph</h2>

        <SettingRow
          label="Graph node limit"
          description="Maximum number of symbols returned by wicked-estate graph-view per repo. Higher values show more of the graph but take longer to render. Requires reopening the graph modal to take effect."
        >
          <input
            type="number"
            min={20}
            max={500}
            step={10}
            value={merged.graphNodeLimit}
            onChange={(e) => patch('graphNodeLimit', Math.max(20, Math.min(500, Number(e.target.value))))}
            className="w-24 rounded border border-gray-300 px-2 py-1 text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </SettingRow>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!hasDirty || saving}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            hasDirty && !saving
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-600 font-medium">Saved</span>}
      </div>
    </div>
  );
}
