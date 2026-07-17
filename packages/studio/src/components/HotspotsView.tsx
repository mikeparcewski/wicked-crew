import { useState } from 'react';
import type { CodeGraphNode } from '../api/types.js';

interface Props {
  nodes: CodeGraphNode[];
  onSelect?: (node: CodeGraphNode) => void;
}

const LANG_COLORS: Record<string, string> = {
  typescript: '#10b981',
  javascript: '#10b981',
  rust: '#f97316',
  python: '#3b82f6',
  go: '#06b6d4',
};

export function HotspotsView({ nodes, onSelect }: Props): React.ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const top30 = [...nodes].sort((a, b) => b.inDeg - a.inDeg).slice(0, 30);
  const maxInDeg = top30[0]?.inDeg ?? 1;

  // Group by first path segment, preserving inDeg-sorted order within each group.
  const groups = new Map<string, CodeGraphNode[]>();
  for (const n of top30) {
    const seg = n.id.split('/')[0] ?? '';
    let arr = groups.get(seg);
    if (!arr) { arr = []; groups.set(seg, arr); }
    arr.push(n);
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {Array.from(groups.entries()).map(([seg, groupNodes]) => (
        <div key={seg}>
          <div className="sticky top-0 z-10 bg-gray-100 border-b border-gray-200 px-3 py-1 flex items-center gap-1.5">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
              {seg || '(root)'}
            </span>
            <span className="text-[10px] text-gray-400">{groupNodes.length}</span>
          </div>
          {groupNodes.map((n) => {
            const color = LANG_COLORS[n.lang.toLowerCase()] ?? '#9ca3af';
            const barPct = maxInDeg > 0 ? (n.inDeg / maxInDeg) * 100 : 0;
            const isSelected = n.id === selectedId;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  setSelectedId(n.id);
                  onSelect?.(n);
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                  isSelected ? 'bg-emerald-50' : 'hover:bg-gray-50'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span
                  className="flex-1 font-mono truncate text-gray-700 min-w-0"
                  title={n.id}
                >
                  {n.id}
                </span>
                <span className="w-24 shrink-0">
                  <span
                    className="block h-1.5 rounded bg-emerald-400"
                    style={{ width: `${barPct}%` }}
                  />
                </span>
                <span className="shrink-0 text-[10px] text-gray-400 w-6 text-right tabular-nums">
                  {n.inDeg}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
