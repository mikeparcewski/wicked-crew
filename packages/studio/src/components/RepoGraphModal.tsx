import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client.js';
import type { RepoEntry, CodeGraphNode, CodeGraphData } from '../api/types.js';
import { ForceGraph } from './ForceGraph.js';
import { HotspotsView } from './HotspotsView.js';

interface Props {
  repo: RepoEntry;
  onClose: () => void;
}

type TabId = 'graph' | 'hotspots';

function ForceGraphContainer({
  nodes,
  edges,
  highlightId,
}: {
  nodes: CodeGraphData['nodes'];
  edges: CodeGraphData['edges'];
  highlightId: string | null;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setDims({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full overflow-hidden">
      <ForceGraph
        nodes={nodes}
        edges={edges}
        width={dims.w}
        height={dims.h}
        {...(highlightId !== null ? { externalSelectedId: highlightId } : {})}
      />
    </div>
  );
}

export function RepoGraphModal({ repo, onClose }: Props): React.ReactElement {
  const [tab, setTab] = useState<TabId>('graph');
  const [loading, setLoading] = useState(true);
  const [graphData, setGraphData] = useState<CodeGraphData | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .getRepoGraph(repo.id)
      .then(({ graph }) => setGraphData(graph))
      .catch(() => setGraphData(null))
      .finally(() => setLoading(false));
  }, [repo.id]);

  function handleHotspotSelect(node: CodeGraphNode): void {
    setHighlightId(node.id);
    setTab('graph');
  }

  const isEmpty = !graphData || graphData.nodes.length === 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[90vw] h-[90vh] bg-white rounded-2xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-base font-semibold text-gray-800">{repo.name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none w-8 h-8 flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="flex gap-1 px-6 py-2 border-b shrink-0">
          {(['graph', 'hotspots'] as TabId[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-[11px] font-medium capitalize ${
                tab === t ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {t === 'graph' ? 'Graph' : 'Hotspots'}
            </button>
          ))}
          {graphData && (
            <span className="ml-auto text-[10px] text-gray-400 self-center">
              {graphData.stats.nodeCount} nodes · {graphData.stats.edgeCount} edges
            </span>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">Loading graph…</p>
            </div>
          ) : isEmpty ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">
                Code graph not yet available — run onboarding first
              </p>
            </div>
          ) : tab === 'graph' ? (
            <ForceGraphContainer
              nodes={graphData!.nodes}
              edges={graphData!.edges}
              highlightId={highlightId}
            />
          ) : (
            <HotspotsView nodes={graphData!.nodes} onSelect={handleHotspotSelect} />
          )}
        </div>
      </div>
    </div>
  );
}
