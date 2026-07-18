import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { CodeGraphData, RepoEntry } from '../api/types.js';
import { ForceGraph } from './ForceGraph.js';
import { RepoGraphModal } from './RepoGraphModal.js';

type TabId = 'all' | 'graph';
type SourceMode = 'local' | 'remote';
type GraphMode = 'code' | 'domain';

interface Props {
  onSelectRun?: (runId: string) => void;
}

export function RepositoriesPanel({ onSelectRun }: Props): React.ReactElement {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('all');

  const [graphRepo, setGraphRepo] = useState<RepoEntry | null>(null);

  const [graphMode, setGraphMode] = useState<GraphMode>('code');
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());
  const [inlineGraphData, setInlineGraphData] = useState<CodeGraphData | null>(null);
  const [inlineGraphLoading, setInlineGraphLoading] = useState(false);

  const [rerunning, setRerunning] = useState<Record<string, boolean>>({});
  const [rerunError, setRerunError] = useState<Record<string, string>>({});
  const [showRegister, setShowRegister] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('local');
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newGitUrl, setNewGitUrl] = useState('');
  const [checkoutPath, setCheckoutPath] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const nameEditedRef = useRef(false);

  const [onboardRunIds, setOnboardRunIds] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoading(true);
    api
      .listRepos()
      .then(({ repos: rs }) => setRepos(rs))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (tab !== 'graph' || graphMode !== 'code') return;
    const firstId = Array.from(selectedRepoIds)[0];
    if (!firstId) { setInlineGraphData(null); return; }
    setInlineGraphLoading(true);
    api
      .getRepoGraph(firstId)
      .then(({ graph }) => setInlineGraphData(graph))
      .catch(() => setInlineGraphData(null))
      .finally(() => setInlineGraphLoading(false));
  }, [tab, graphMode, selectedRepoIds]);

  function deriveName(value: string): void {
    if (nameEditedRef.current) return;
    const segment = value.replace(/\.git$/, '').split(/[/\\:]/).filter(Boolean).pop() ?? '';
    if (segment) setNewName(segment);
  }

  async function rerunOnboarding(repoId: string): Promise<void> {
    setRerunning((prev) => ({ ...prev, [repoId]: true }));
    setRerunError((prev) => ({ ...prev, [repoId]: '' }));
    try {
      const { runId } = await api.rerunOnboarding(repoId);
      setOnboardRunIds((prev) => ({ ...prev, [repoId]: runId }));
      onSelectRun?.(runId);
    } catch (err) {
      setRerunError((prev) => ({ ...prev, [repoId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRerunning((prev) => ({ ...prev, [repoId]: false }));
    }
  }

  async function registerRepo(): Promise<void> {
    const name = newName.trim();
    const isRemote = sourceMode === 'remote';
    const target = isRemote ? newGitUrl.trim() : newPath.trim();
    if (!name || !target) return;

    setRegisterError(null);
    setRegistering(true);
    try {
      const { repo, onboardRunId } = isRemote
        ? await api.cloneAndRegisterRepo(name, target, checkoutPath.trim() || undefined)
        : await api.registerRepo(name, target);

      setRepos((prev) => [...prev, repo]);
      setOnboardRunIds((prev) => ({ ...prev, [repo.id]: onboardRunId }));
      setShowRegister(false);
      setNewName('');
      setNewPath('');
      setNewGitUrl('');
      setCheckoutPath('');
      setSourceMode('local');
      nameEditedRef.current = false;

      onSelectRun?.(onboardRunId);
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegistering(false);
    }
  }

  const canSubmit = Boolean(
    newName.trim() && (sourceMode === 'remote' ? newGitUrl.trim() : newPath.trim()),
  );

  const inputStyle = {
    background: '#0f1419',
    border: '1px solid rgba(230,237,243,0.14)',
    color: '#e6edf3',
    borderRadius: '6px',
    padding: '6px 8px',
    fontSize: '12px',
    outline: 'none',
    width: '100%',
  };

  return (
    <div className="flex flex-col h-full" style={{ background: '#161c26' }}>
      <div className="px-6 py-4 shrink-0" style={{ borderBottom: '1px solid rgba(230,237,243,0.07)' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold" style={{ color: '#e6edf3' }}>Repositories</h2>
          <button
            type="button"
            onClick={() => setShowRegister((v) => !v)}
            className="rounded px-3 py-1 text-[11px] font-semibold"
            style={{ background: '#ffda19', color: '#0d1117' }}
          >
            {showRegister ? 'Cancel' : 'Add repository'}
          </button>
        </div>

        {showRegister && (
          <div
            className="flex flex-col gap-2 mt-2 rounded-lg p-3"
            style={{ background: '#0f1419', border: '1px solid rgba(230,237,243,0.07)' }}
          >
            <div className="flex gap-1">
              {(['local', 'remote'] as SourceMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSourceMode(m)}
                  className="rounded px-2.5 py-1 text-[11px] font-medium capitalize transition-colors"
                  style={sourceMode === m
                    ? { background: 'rgba(230,237,243,0.12)', color: '#e6edf3' }
                    : { color: 'rgba(230,237,243,0.4)' }}
                >
                  {m === 'local' ? 'Local path' : 'Remote URL'}
                </button>
              ))}
            </div>

            <input
              style={inputStyle}
              placeholder="Repo name"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                nameEditedRef.current = Boolean(e.target.value.trim());
              }}
            />

            {sourceMode === 'local' ? (
              <input
                style={{ ...inputStyle, fontFamily: 'var(--wk-font-mono, monospace)' }}
                placeholder="Absolute path to git repo"
                value={newPath}
                onChange={(e) => { setNewPath(e.target.value); deriveName(e.target.value); }}
              />
            ) : (
              <>
                <input
                  style={{ ...inputStyle, fontFamily: 'var(--wk-font-mono, monospace)' }}
                  placeholder="https://github.com/org/repo or git@github.com:org/repo"
                  value={newGitUrl}
                  onChange={(e) => { setNewGitUrl(e.target.value); deriveName(e.target.value); }}
                />
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] font-medium" style={{ color: 'rgba(230,237,243,0.4)' }}>Clone to (optional)</label>
                  <input
                    style={{ ...inputStyle, fontFamily: 'var(--wk-font-mono, monospace)' }}
                    placeholder={`~/.wicked/repos/${newName || '<name>'}`}
                    value={checkoutPath}
                    onChange={(e) => setCheckoutPath(e.target.value)}
                  />
                </div>
              </>
            )}

            <p className="text-[10px]" style={{ color: 'rgba(230,237,243,0.4)' }}>
              {sourceMode === 'remote'
                ? `Clones to ${checkoutPath.trim() || `~/.wicked/repos/${newName || '<name>'}`}, then runs the onboarding workflow as a governed run — visible in the run list.`
                : 'Runs the onboarding workflow (index → annotate → domain) as a governed run — visible in the run list.'}
            </p>

            {registerError && <p className="text-[11px] font-mono" style={{ color: '#f85149' }}>{registerError}</p>}

            <button
              type="button"
              onClick={() => void registerRepo()}
              disabled={registering || !canSubmit}
              className="self-start rounded px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
              style={{ background: '#ffda19', color: '#0d1117' }}
            >
              {registering
                ? sourceMode === 'remote' ? 'Cloning…' : 'Registering…'
                : sourceMode === 'remote' ? 'Clone & onboard' : 'Register & onboard'}
            </button>
          </div>
        )}

        <div className="flex gap-1 mt-3">
          {(['all', 'graph'] as TabId[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className="rounded px-3 py-1 text-[11px] font-medium capitalize transition-colors"
              style={tab === t
                ? { background: 'rgba(230,237,243,0.12)', color: '#e6edf3' }
                : { color: 'rgba(230,237,243,0.45)' }}
            >
              {t === 'all' ? 'All' : 'Graph view'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'graph' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <div className="flex gap-1">
                {(['code', 'domain'] as GraphMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setGraphMode(m)}
                    className="rounded px-3 py-1 text-[11px] font-medium capitalize transition-colors"
                    style={graphMode === m
                      ? { background: 'rgba(230,237,243,0.12)', color: '#e6edf3' }
                      : { color: 'rgba(230,237,243,0.45)' }}
                  >
                    {m === 'code' ? 'Code' : 'Domain'}
                  </button>
                ))}
              </div>
            </div>

            {repos.length === 0 ? (
              <p className="text-xs" style={{ color: 'rgba(230,237,243,0.4)' }}>No repositories registered yet.</p>
            ) : (
              <div className="flex flex-col gap-1">
                <p className="text-[10px] mb-1" style={{ color: 'rgba(230,237,243,0.4)' }}>Select repos to visualize</p>
                {repos.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedRepoIds.has(r.id)}
                      onChange={(e) => {
                        setSelectedRepoIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        });
                      }}
                      style={{ accentColor: '#ffda19' }}
                    />
                    <span className="text-xs" style={{ color: '#e6edf3' }}>{r.name}</span>
                  </label>
                ))}
              </div>
            )}

            {graphMode === 'code' && selectedRepoIds.size > 0 && (
              <div
                className="rounded-lg overflow-hidden"
                style={{ height: 400, border: '1px solid rgba(230,237,243,0.1)' }}
              >
                {inlineGraphLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-xs" style={{ color: 'rgba(230,237,243,0.4)' }}>Loading graph…</p>
                  </div>
                ) : !inlineGraphData || inlineGraphData.nodes.length === 0 ? (
                  <div className="flex items-center justify-center h-full" style={{ background: '#0f1419' }}>
                    <p className="text-xs" style={{ color: 'rgba(230,237,243,0.4)' }}>
                      Code graph not yet available — run onboarding first
                    </p>
                  </div>
                ) : (
                  <ForceGraph
                    nodes={inlineGraphData.nodes}
                    edges={inlineGraphData.edges}
                    width={600}
                    height={400}
                  />
                )}
              </div>
            )}

            {graphMode === 'domain' && (
              <div
                className="rounded-lg p-6 text-center text-sm"
                style={{ background: '#0f1419', border: '1px dashed rgba(230,237,243,0.12)', color: 'rgba(230,237,243,0.4)' }}
              >
                Domain graph — open a repo's modal and use the Hotspots tab, or switch to Code mode to browse the file graph.
              </div>
            )}
          </div>
        ) : loading ? (
          <p className="text-xs" style={{ color: 'rgba(230,237,243,0.4)' }}>Loading repositories…</p>
        ) : error ? (
          <p className="text-xs font-mono" style={{ color: '#f85149' }}>{error}</p>
        ) : repos.length === 0 ? (
          <p className="text-xs" style={{ color: 'rgba(230,237,243,0.4)' }}>No repositories registered yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {repos.map((r) => {
              const runId = onboardRunIds[r.id];
              return (
                <div
                  key={r.id}
                  className="rounded-lg p-4"
                  style={{ background: '#1b222e', border: '1px solid rgba(230,237,243,0.08)' }}
                >
                  <p className="text-sm font-semibold" style={{ color: '#e6edf3' }}>{r.name}</p>
                  <p className="text-[11px] font-mono mt-0.5" style={{ color: 'rgba(230,237,243,0.45)' }}>{r.root_path}</p>
                  {r.git_url && (
                    <p className="text-[10px] font-mono mt-0.5 truncate" style={{ color: 'rgba(230,237,243,0.35)' }} title={r.git_url}>
                      ↳ {r.git_url}
                    </p>
                  )}
                  <div className="mt-1 flex gap-4 text-[11px]" style={{ color: 'rgba(230,237,243,0.35)' }}>
                    <span>branch: {r.default_branch}</span>
                    <span>registered: {new Date(r.registered_at * 1000).toLocaleDateString()}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    {runId && onSelectRun && (
                      <button
                        type="button"
                        onClick={() => onSelectRun(runId)}
                        className="text-[11px] hover:underline"
                        style={{ color: '#79c0ff' }}
                      >
                        View onboarding run →
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setGraphRepo(r)}
                      className="text-[11px] hover:underline"
                      style={{ color: '#79c0ff' }}
                    >
                      View graph →
                    </button>
                    <button
                      type="button"
                      disabled={rerunning[r.id]}
                      onClick={() => void rerunOnboarding(r.id)}
                      className="text-[11px] hover:underline disabled:opacity-50"
                      style={{ color: 'rgba(230,237,243,0.45)' }}
                    >
                      {rerunning[r.id] ? 'Starting…' : '↺ Re-run onboarding'}
                    </button>
                  </div>
                  {rerunError[r.id] && (
                    <p className="mt-1 text-[11px] font-mono" style={{ color: '#f85149' }}>{rerunError[r.id]}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {graphRepo && (
        <RepoGraphModal repo={graphRepo} onClose={() => setGraphRepo(null)} />
      )}
    </div>
  );
}
