import { useState } from 'react';
import type { SessionView } from '../api/types.js';
import { ConnectionStatus } from './ConnectionStatus.js';
import { RunLink } from './RunLink.js';
import { SettingsMenu } from './SettingsMenu.js';
import { WickedLogo } from './WickedLogo.js';

interface Props {
  runs: SessionView[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  navigate: (path: string) => void;
}

// Wicked teal-blue sidebar palette
const S = {
  bg:       '#1c4053',
  border:   'rgba(0,0,0,0.25)',
  ink:      '#e6edf3',
  muted:    'rgba(230,237,243,0.6)',
  faint:    'rgba(230,237,243,0.3)',
  hover:    'rgba(0,0,0,0.2)',
  active:   'rgba(0,0,0,0.35)',
  // primary action: wicked yellow
  accent:   '#ffda19',
  accentInk:'#0d1117',
  // link blue for secondary
  link:     '#79c0ff',
};

export function LeftSidebar({ runs, selectedRunId, onSelectRun, navigate }: Props): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div
      className={`flex flex-col shrink-0 transition-all duration-200 ${collapsed ? 'w-14' : 'w-60'}`}
      style={{ background: S.bg, borderRight: `1px solid ${S.border}` }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-4 pb-3 shrink-0">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="shrink-0"
          aria-label="Home"
        >
          <WickedLogo size={26} />
        </button>
        {!collapsed && (
          <span className="flex-1 text-sm font-semibold truncate font-mono" style={{ color: S.ink }}>
            wicked crew
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="ml-auto text-xs font-mono shrink-0 leading-none"
          style={{ color: S.faint }}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {/* Action buttons */}
      <div className={`px-2 flex flex-col gap-1 shrink-0 ${collapsed ? 'items-center' : ''}`}>
        {/* Primary: wicked yellow */}
        <button
          type="button"
          data-testid="new-run"
          onClick={() => navigate('/')}
          aria-label="New run"
          className={`rounded text-xs font-semibold transition-opacity hover:opacity-90 ${
            collapsed ? 'w-9 h-9 flex items-center justify-center' : 'w-full py-1.5 px-3'
          }`}
          style={{ background: S.accent, color: S.accentInk }}
        >
          {collapsed ? '+' : 'New run'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/repos')}
          aria-label="Repositories"
          className={`rounded text-xs transition-colors ${
            collapsed
              ? 'w-9 h-9 flex items-center justify-center'
              : 'w-full py-1.5 px-3 text-left'
          }`}
          style={{ color: S.muted }}
          onMouseEnter={(e) => { e.currentTarget.style.background = S.hover; e.currentTarget.style.color = S.ink; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = ''; e.currentTarget.style.color = S.muted; }}
        >
          {collapsed ? '⊞' : 'Repositories'}
        </button>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto mt-3 px-2 flex flex-col gap-0.5">
        {runs.length === 0 ? (
          !collapsed && (
            <p className="px-2 text-[11px] italic font-mono" style={{ color: S.faint }}>No runs yet</p>
          )
        ) : (
          runs.map((v) =>
            collapsed ? (
              <button
                key={v.session.id}
                type="button"
                onClick={() => onSelectRun(v.session.id)}
                aria-label={v.session.problem}
                title={v.session.problem}
                className="w-9 h-9 mx-auto flex items-center justify-center rounded-md transition-colors"
                style={{ background: selectedRunId === v.session.id ? S.active : 'transparent' }}
              >
                <CollapsedDot status={v.session.status} />
              </button>
            ) : (
              <RunLink
                key={v.session.id}
                view={v}
                selectedRunId={selectedRunId}
                onSelect={onSelectRun}
              />
            )
          )
        )}
      </div>

      {/* Footer */}
      <div className={`px-2 pb-3 shrink-0 flex flex-col gap-1 ${collapsed ? 'items-center' : ''}`}>
        {!collapsed && (
          <div className="px-1">
            <ConnectionStatus />
          </div>
        )}
        {!collapsed && (
          <p className="text-[10px] px-1 font-mono" style={{ color: S.faint }}>v0.2.1</p>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Settings"
            className={`rounded transition-colors ${
              collapsed
                ? 'w-9 h-9 flex items-center justify-center text-base'
                : 'w-full flex items-center gap-2 px-2 py-1.5 text-xs'
            }`}
            style={{ color: S.faint }}
            onMouseEnter={(e) => { e.currentTarget.style.background = S.hover; e.currentTarget.style.color = S.ink; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = ''; e.currentTarget.style.color = S.faint; }}
          >
            <span>⚙</span>
            {!collapsed && <span>Settings</span>}
          </button>
          {settingsOpen && (
            <SettingsMenu
              onNavigate={navigate}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CollapsedDot({ status }: { status: string }): React.ReactElement {
  const color =
    status === 'completed'      ? '#3fb950' :
    status === 'failed'         ? '#f85149' :
    status === 'cancelled'      ? 'rgba(230,237,243,0.25)' :
    status === 'awaiting_human' ? '#ffda19' :
    '#79c0ff';
  const pulse = status === 'awaiting_human' || status === 'executing' || status === 'distributing' || status === 'planning';
  return (
    <span
      className={`w-2.5 h-2.5 rounded-full ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  );
}
