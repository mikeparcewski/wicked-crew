import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { OnboardStatus, OnboardStep, RepoEntry } from '../api/types.js';

type TabId = 'all' | 'graph';
type SourceMode = 'local' | 'remote';

const STEP_ICON: Record<OnboardStep['status'], string> = {
  pending:  '○',
  running:  '◌',
  done:     '✓',
  failed:   '✗',
  skipped:  '—',
};

const STEP_COLOR: Record<OnboardStep['status'], string> = {
  pending:  'text-zinc-400',
  running:  'text-blue-500 animate-pulse',
  done:     'text-emerald-500',
  failed:   'text-red-500',
  skipped:  'text-zinc-400',
};

function OnboardProgress({ repoId, initial }: { repoId: string; initial: OnboardStatus }) {
  const [state, setState] = useState<OnboardStatus>(initial);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'unknown') return;

    timerRef.current = setInterval(() => {
      void api.getOnboardStatus(repoId).then((s) => {
        setState(s);
        if (s.status === 'completed' || s.status === 'failed') {
          if (timerRef.current) clearInterval(timerRef.current);
        }
      });
    }, 1500);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [repoId, state.status]);

  if (state.status === 'unknown') return null;

  return (
    <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 px-3 py-2">
      <p className="text-[11px] font-semibold text-zinc-600 mb-1.5">
        {state.status === 'completed' && '✓ Onboarding complete'}
        {state.status === 'failed' && '✗ Onboarding failed'}
        {(state.status === 'running' || state.status === 'pending') && 'Onboarding…'}
      </p>
      <div className="flex flex-col gap-0.5">
        {state.steps.map((step) => (
          <div key={step.id} className="flex items-center gap-2 text-[11px]">
            <span className={`font-mono ${STEP_COLOR[step.status]}`}>
              {STEP_ICON[step.status]}
            </span>
            <span className={step.status === 'running' ? 'text-blue-600' : 'text-zinc-600'}>
              {step.label}
            </span>
            {step.detail && (
              <span className="truncate text-red-500 text-[10px]" title={step.detail}>
                {step.detail.slice(0, 60)}
              </span>
            )}
          </div>
        ))}
      </div>
      {state.status === 'failed' && state.error && (
        <p className="mt-1 text-[10px] text-red-600 break-words">{state.error}</p>
      )}
      {state.status === 'completed' && state.estateDb && (
        <p className="mt-1 text-[10px] text-zinc-400 font-mono break-all">{state.estateDb}</p>
      )}
    </div>
  );
}

export function RepositoriesPanel(): React.ReactElement {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('all');

  const [showRegister, setShowRegister] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('local');
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newGitUrl, setNewGitUrl] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  // Per-repo onboard state keyed by repo id
  const [onboardStates, setOnboardStates] = useState<Record<string, OnboardStatus>>({});

  useEffect(() => {
    setLoading(true);
    api
      .listRepos()
      .then(({ repos: rs }) => setRepos(rs))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  // Auto-derive name from the last segment of a path or URL
  function deriveName(value: string): void {
    if (newName) return; // user already typed a name
    const segment = value.replace(/\.git$/, '').split(/[/\\:]/).filter(Boolean).pop() ?? '';
    if (segment) setNewName(segment);
  }

  async function registerRepo(): Promise<void> {
    const name = newName.trim();
    const isRemote = sourceMode === 'remote';
    const target = isRemote ? newGitUrl.trim() : newPath.trim();
    if (!name || !target) return;

    setRegisterError(null);
    setRegistering(true);
    try {
      const { repo } = isRemote
        ? await api.cloneAndRegisterRepo(name, target)
        : await api.registerRepo(name, target);

      setRepos((prev) => [...prev, repo]);
      // Seed onboard state as running so the progress widget appears immediately
      setOnboardStates((prev) => ({
        ...prev,
        [repo.id]: { status: 'running', steps: [] },
      }));
      setShowRegister(false);
      setNewName('');
      setNewPath('');
      setNewGitUrl('');
      setSourceMode('local');
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegistering(false);
    }
  }

  const canSubmit = Boolean(
    newName.trim() && (sourceMode === 'remote' ? newGitUrl.trim() : newPath.trim()),
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-800">Repositories</h2>
          <button
            type="button"
            onClick={() => setShowRegister((v) => !v)}
            className="rounded bg-emerald-600 px-3 py-1 text-[11px] text-white hover:bg-emerald-700"
          >
            {showRegister ? 'Cancel' : 'Add repository'}
          </button>
        </div>

        {showRegister && (
          <div className="flex flex-col gap-2 mt-2 rounded-lg border p-3 bg-gray-50">
            {/* Source mode toggle */}
            <div className="flex gap-1">
              {(['local', 'remote'] as SourceMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSourceMode(m)}
                  className={`rounded px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                    sourceMode === m
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-500 hover:bg-zinc-100'
                  }`}
                >
                  {m === 'local' ? 'Local path' : 'Remote URL'}
                </button>
              ))}
            </div>

            <input
              className="rounded border p-2 text-xs"
              placeholder="Repo name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />

            {sourceMode === 'local' ? (
              <input
                className="rounded border p-2 text-xs font-mono"
                placeholder="Absolute path to git repo (e.g. /Users/you/my-project)"
                value={newPath}
                onChange={(e) => {
                  setNewPath(e.target.value);
                  deriveName(e.target.value);
                }}
              />
            ) : (
              <input
                className="rounded border p-2 text-xs font-mono"
                placeholder="Git URL (https://github.com/org/repo or git@github.com:org/repo)"
                value={newGitUrl}
                onChange={(e) => {
                  setNewGitUrl(e.target.value);
                  deriveName(e.target.value);
                }}
              />
            )}

            {sourceMode === 'remote' && (
              <p className="text-[10px] text-zinc-500">
                The repo will be cloned to <code className="font-mono">~/.wicked/repos/&lt;name&gt;</code>{' '}
                then indexed: code graph → community detection → domain nodes.
              </p>
            )}
            {sourceMode === 'local' && (
              <p className="text-[10px] text-zinc-500">
                Local repos are indexed in place: code graph → community detection → domain nodes.
              </p>
            )}

            {registerError && (
              <p className="text-[11px] text-red-600">{registerError}</p>
            )}
            <button
              type="button"
              onClick={() => void registerRepo()}
              disabled={registering || !canSubmit}
              className="self-start rounded bg-emerald-600 px-3 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {registering
                ? sourceMode === 'remote'
                  ? 'Cloning…'
                  : 'Registering…'
                : sourceMode === 'remote'
                  ? 'Clone & onboard'
                  : 'Register & onboard'}
            </button>
          </div>
        )}

        <div className="flex gap-1 mt-3">
          {(['all', 'graph'] as TabId[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-[11px] font-medium capitalize ${
                tab === t
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {t === 'all' ? 'All' : 'Graph view'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'graph' ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-400">
            Cross-repo code / requirements / domain graph — coming soon
          </div>
        ) : loading ? (
          <p className="text-xs text-gray-400">Loading repositories…</p>
        ) : error ? (
          <p className="text-xs text-red-600">{error}</p>
        ) : repos.length === 0 ? (
          <p className="text-xs text-gray-400">No repositories registered yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {repos.map((r) => (
              <div key={r.id} className="rounded-lg border bg-white p-4 shadow-sm">
                <p className="text-sm font-semibold text-gray-800">{r.name}</p>
                <p className="text-[11px] text-gray-500 font-mono mt-0.5">{r.root_path}</p>
                {r.git_url && (
                  <p className="text-[10px] text-zinc-400 font-mono mt-0.5 truncate" title={r.git_url}>
                    ↳ {r.git_url}
                  </p>
                )}
                <div className="mt-1 flex gap-4 text-[11px] text-gray-400">
                  <span>branch: {r.default_branch}</span>
                  <span>registered: {new Date(r.registered_at * 1000).toLocaleDateString()}</span>
                </div>
                {onboardStates[r.id] && (
                  <OnboardProgress repoId={r.id} initial={onboardStates[r.id]!} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
