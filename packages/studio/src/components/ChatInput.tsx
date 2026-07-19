import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { EntityMode, LaunchRunBody, RepoEntry, RosterSeat, WorkflowDef } from '../api/types.js';
import { useGateStore } from '../store/gates.js';

interface Props {
  /** If set, we're in "run selected" mode — steer if gated, otherwise placeholder. */
  runId?: string | null;
  /** The current status of the selected run. Used to decide steer vs disabled mode. */
  runStatus?: string | null;
  onLaunched: (runId: string) => void;
}

type ConfirmMode = 'none' | 'all' | 'before';

const WORKFLOW_LABELS: Record<string, string> = {
  feature: 'Feature (6 phases)',
  bug: 'Bug (4 phases)',
  migration: 'Migration (5 phases)',
};

function detectWorkflow(text: string): string | null {
  const lower = text.toLowerCase();
  if (/\b(bug|fix|broken|error|crash|issue)\b/.test(lower)) return 'bug';
  if (/\b(feature|implement|add|create)\b/.test(lower) && !/\b(bug|fix|broken|error|crash|issue)\b/.test(lower)) return 'feature';
  if (/\b(migrate|upgrade|migration|move)\b/.test(lower)) return 'migration';
  return null;
}

export function ChatInput({ runId, runStatus, onLaunched }: Props): React.ReactElement {
  const clearGate = useGateStore((s) => s.clearGate);
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  const [steerError, setSteerError] = useState<string | null>(null);
  const steerRef = useRef<HTMLTextAreaElement>(null);
  const [problem, setProblem] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [roster, setRoster] = useState<RosterSeat[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [selectedClis, setSelectedClis] = useState<Set<string>>(new Set());
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [repoRef, setRepoRef] = useState('');
  const [entityMode, setEntityMode] = useState<EntityMode>('shared');
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>('none');
  const [beforeOrd, setBeforeOrd] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [detectedWorkflow, setDetectedWorkflow] = useState<string | null>(null);
  const [workflowDismissed, setWorkflowDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .getRoster()
      .then(({ roster: seats }) => {
        setRoster(seats);
        setSelectedClis(new Set(seats.filter((s) => s.enabled_for_council).map((s) => s.key)));
      })
      .catch(() => {/* roster load failure is non-fatal */});
    api.listRepos().then(({ repos: rs }) => setRepos(rs)).catch(() => {});
    api.listWorkflows().then(({ workflows: wfs }) => setWorkflows(wfs)).catch(() => {});
  }, []);

  useEffect(() => {
    if (submitting) {
      setElapsedSecs(0);
      timerRef.current = setInterval(() => setElapsedSecs((s) => s + 1), 1000);
    } else {
      if (timerRef.current !== null) { clearInterval(timerRef.current); timerRef.current = null; }
      setElapsedSecs(0);
    }
    return () => { if (timerRef.current !== null) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [submitting]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const lineHeight = 20;
    const maxHeight = lineHeight * 5;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, [problem]);

  // Signal detection
  useEffect(() => {
    if (!problem.trim() || workflow) {
      setDetectedWorkflow(null);
      return;
    }
    setDetectedWorkflow(detectWorkflow(problem));
  }, [problem, workflow]);

  function toggleCli(key: string): void {
    setSelectedClis((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function workflowLabel(id: string): string {
    const wf = workflows.find((w) => w.id === id);
    if (wf) {
      return `${id.charAt(0).toUpperCase() + id.slice(1)} (${wf.phases.length} phases: ${wf.phases.map((p) => p.id).join(' → ')})`;
    }
    return WORKFLOW_LABELS[id] ?? id;
  }

  async function submit(): Promise<void> {
    if (!problem.trim() || selectedClis.size === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const body: LaunchRunBody = { problem: problem.trim() };
    const seats = roster.filter((s) => selectedClis.has(s.key));
    if (seats.length > 0) body.clisJson = JSON.stringify(seats);
    body.entityMode = entityMode;
    if (confirmMode === 'all') body.humanConfirm = 'all';
    else if (confirmMode === 'before') body.humanConfirm = `before:${beforeOrd}`;
    if (repoRef) body.repoRef = repoRef;
    if (workflow) body.workflow = workflow;
    try {
      const { runId: newRunId } = await api.launchRun(body);
      setProblem('');
      onLaunched(newRunId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Run-selected mode: steer at gates, otherwise explain the state
  if (runId) {
    if (runStatus === 'awaiting_human') {
      // Gate is open — operator can send a steer (approve-with-steer)
      const canSteer = steerText.trim().length > 0 && !steering;

      async function submitSteer(): Promise<void> {
        const text = steerText.trim();
        if (!text || !runId) return;
        setSteering(true);
        setSteerError(null);
        try {
          await api.confirmGate(runId, { approve: true, amend: text });
          setSteerText('');
          clearGate(runId);
        } catch (err) {
          setSteerError(err instanceof Error ? err.message : String(err));
        } finally {
          setSteering(false);
        }
      }

      return (
        <div
          className="px-5 py-4 flex flex-col gap-2 shrink-0"
          style={{ borderTop: '1px solid rgba(230,237,243,0.07)', background: '#161c26' }}
        >
          {steerError && (
            <p className="text-[11px] font-mono" style={{ color: '#f85149' }}>{steerError}</p>
          )}
          <div
            className="flex items-end gap-3 rounded-2xl px-4 py-3"
            style={{ background: '#1b222e', border: '1px solid rgba(255,218,25,0.25)' }}
          >
            <textarea
              ref={steerRef}
              className="flex-1 resize-none text-base outline-none border-0 bg-transparent leading-6"
              style={{ minHeight: '28px', color: '#e6edf3', fontFamily: 'inherit' }}
              placeholder="Send steering guidance… (approves gate)"
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submitSteer();
                }
              }}
              disabled={steering}
              rows={1}
            />
            <button
              type="button"
              onClick={() => void submitSteer()}
              disabled={!canSteer}
              className="shrink-0 rounded-xl px-4 py-2 text-sm font-semibold transition-opacity disabled:opacity-40"
              style={{ background: '#ffda19', color: '#0d1117' }}
            >
              {steering ? '…' : 'Steer →'}
            </button>
          </div>
          <p className="text-[10px] font-mono text-center" style={{ color: 'rgba(230,237,243,0.3)' }}>
            Approve + steer · Cmd+Enter · Use the gate panel above to approve/reject without steering
          </p>
        </div>
      );
    }

    // Actively executing — no mid-run injection supported
    return (
      <div className="px-5 py-4 shrink-0" style={{ borderTop: '1px solid rgba(230,237,243,0.07)', background: '#161c26' }}>
        <div className="rounded-2xl px-5 py-4" style={{ border: '1px solid rgba(230,237,243,0.1)', background: '#1b222e' }}>
          <p className="text-sm italic font-mono" style={{ color: 'rgba(230,237,243,0.35)' }}>
            Run in progress — steer at the next gate.
          </p>
        </div>
      </div>
    );
  }

  const canSubmit = problem.trim().length > 0 && selectedClis.size > 0 && !submitting;
  const showDetection = detectedWorkflow !== null && !workflowDismissed && !workflow;

  return (
    <div
      className="px-5 py-4 flex flex-col gap-3 shrink-0"
      style={{ borderTop: '1px solid rgba(230,237,243,0.07)', background: '#161c26' }}
    >
      {showDetection && (
        <div
          className="flex items-center gap-2 text-xs rounded-xl px-4 py-2 font-mono"
          style={{ background: '#161c26', border: '1px solid rgba(230,237,243,0.1)', color: 'rgba(230,237,243,0.7)' }}
        >
          <span>Detected: <strong style={{ color: '#ffda19' }}>{detectedWorkflow}</strong> workflow</span>
          <button
            type="button"
            onClick={() => { setWorkflow(detectedWorkflow!); setWorkflowDismissed(true); }}
            className="rounded-lg px-3 py-1 font-semibold text-xs"
            style={{ background: '#ffda19', color: '#0d1117' }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setWorkflowDismissed(true)}
            className="ml-auto"
            style={{ color: 'rgba(230,237,243,0.35)' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Main input row */}
      <div
        className="flex items-end gap-3 rounded-2xl px-4 py-3 transition-all"
        style={{ background: '#1b222e', border: '1px solid rgba(230,237,243,0.14)' }}
      >
        <textarea
          ref={textareaRef}
          data-testid="launch-problem"
          className="flex-1 resize-none text-base outline-none border-0 bg-transparent leading-6"
          style={{ minHeight: '28px', color: '#e6edf3', fontFamily: 'inherit' }}
          placeholder="What do you need built?"
          value={problem}
          onChange={(e) => { setProblem(e.target.value); setWorkflowDismissed(false); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={submitting}
          rows={1}
        />
        <button
          type="button"
          data-testid="launch-submit"
          onClick={() => void submit()}
          disabled={!canSubmit}
          aria-label="Send"
          className="shrink-0 rounded-xl px-5 py-2.5 text-sm font-semibold font-mono disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          style={{ background: '#ffda19', color: '#0d1117' }}
        >
          {submitting ? `${elapsedSecs}s` : 'Send'}
        </button>
      </div>

      {/* Agent checkboxes + options row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-mono" style={{ color: 'rgba(230,237,243,0.45)' }}>
        {roster.map((seat) => (
          <label key={seat.key} className="flex items-center gap-1.5 cursor-pointer" style={{ color: 'rgba(230,237,243,0.55)' }}>
            <input
              type="checkbox"
              className="rounded"
              checked={selectedClis.has(seat.key)}
              onChange={() => toggleCli(seat.key)}
              data-testid={`launch-seat-${seat.key}`}
            />
            <span>{seat.key}</span>
          </label>
        ))}

        <span style={{ color: 'rgba(230,237,243,0.15)' }}>|</span>

        <div className="flex items-center gap-1.5">
          <span>Gate:</span>
          <select
            data-testid="launch-confirm"
            className="rounded-lg px-2 py-1 text-xs font-mono"
            style={{ background: '#161c26', border: '1px solid rgba(230,237,243,0.14)', color: '#e6edf3' }}
            value={confirmMode}
            onChange={(e) => setConfirmMode(e.target.value as ConfirmMode)}
          >
            <option value="none">None</option>
            <option value="all">Every unit</option>
            <option value="before">Before unit #</option>
          </select>
          {confirmMode === 'before' && (
            <input
              type="number"
              min={1}
              value={beforeOrd}
              onChange={(e) => setBeforeOrd(Math.max(1, Number(e.target.value) || 1))}
              className="w-14 rounded-lg px-2 py-1 text-xs font-mono"
              style={{ background: '#161c26', border: '1px solid rgba(230,237,243,0.14)', color: '#e6edf3' }}
            />
          )}
        </div>

        <span style={{ color: 'rgba(230,237,243,0.15)' }}>|</span>

        <div className="flex items-center gap-1.5">
          <span>Mode:</span>
          {(['shared', 'isolated'] as EntityMode[]).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`launch-entity-${m}`}
              onClick={() => setEntityMode(m)}
              className="rounded-lg px-2.5 py-1 capitalize text-xs font-medium font-mono transition-colors"
              style={entityMode === m
                ? { background: 'rgba(230,237,243,0.12)', color: '#e6edf3' }
                : { color: 'rgba(230,237,243,0.4)' }}
            >
              {m}
            </button>
          ))}
        </div>

        <span style={{ color: 'rgba(230,237,243,0.15)' }}>|</span>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="transition-colors font-mono"
          style={{ color: 'rgba(230,237,243,0.4)' }}
        >
          {showAdvanced ? '▾ Advanced' : '▸ Advanced'}
        </button>
      </div>

      {showAdvanced && (
        <div
          className="flex flex-wrap gap-4 rounded-xl px-4 py-3 text-xs font-mono"
          style={{ background: '#161c26', border: '1px solid rgba(230,237,243,0.07)' }}
        >
          <div className="flex items-center gap-2">
            <span style={{ color: 'rgba(230,237,243,0.5)' }}>Workflow:</span>
            <select
              data-testid="launch-workflow"
              className="rounded-lg px-2 py-1 text-xs font-mono"
              style={{ background: '#0f1419', border: '1px solid rgba(230,237,243,0.14)', color: '#e6edf3' }}
              value={workflow}
              onChange={(e) => { setWorkflow(e.target.value); setWorkflowDismissed(true); }}
            >
              <option value="">(free-text)</option>
              {(workflows.length > 0 ? workflows.map((w) => w.id) : Object.keys(WORKFLOW_LABELS)).map((id) => (
                <option key={id} value={id}>{workflowLabel(id)}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span style={{ color: 'rgba(230,237,243,0.5)' }}>Repo:</span>
            <select
              data-testid="launch-repo"
              className="rounded-lg px-2 py-1 text-xs font-mono"
              style={{ background: '#0f1419', border: '1px solid rgba(230,237,243,0.14)', color: '#e6edf3' }}
              value={repoRef}
              onChange={(e) => setRepoRef(e.target.value)}
            >
              <option value="">(none)</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs px-1 font-mono" style={{ color: '#f85149' }} data-testid="launch-error">{error}</p>
      )}

      {submitting && elapsedSecs >= 5 && (
        <p className="text-xs text-center font-mono" style={{ color: 'rgba(230,237,243,0.35)' }}>
          Planning in progress — council routing + plan decomposition takes 30–60 s. Don't re-submit.
        </p>
      )}
    </div>
  );
}
