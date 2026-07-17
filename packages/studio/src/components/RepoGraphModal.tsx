import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client.js';
import type { RepoEntry, CodeGraphNode, CodeGraphEdge, CodeGraphData, DomainGraph } from '../api/types.js';
import { ForceGraph } from './ForceGraph.js';
import { HotspotsView } from './HotspotsView.js';

interface Props {
  repo: RepoEntry;
  onClose: () => void;
}

type TabId = 'graph' | 'hotspots';
type GraphType = 'code' | 'domain';

const LANG_DOT: Record<string, string> = {
  typescript: '#10b981',
  javascript: '#10b981',
  rust: '#f97316',
  python: '#3b82f6',
  go: '#06b6d4',
};

function NodeDetailPanel({
  node,
  edges,
  onClose,
}: {
  node: CodeGraphNode;
  edges: CodeGraphEdge[];
  onClose: () => void;
}): React.ReactElement {
  const imports = edges.filter((e) => e.src === node.id).map((e) => e.tgt);
  const importedBy = edges.filter((e) => e.tgt === node.id).map((e) => e.src);
  const color = LANG_DOT[node.lang.toLowerCase()] ?? '#9ca3af';

  return (
    <div className="w-64 border-l flex flex-col shrink-0 bg-gray-50">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b bg-white shrink-0 min-w-0">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="text-[11px] font-semibold text-gray-700 truncate flex-1" title={node.id}>
          {node.id.split('/').pop()}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 shrink-0 leading-none"
        >
          ×
        </button>
      </div>

      <div className="overflow-y-auto flex-1 p-3 flex flex-col gap-3 text-[11px]">
        <div>
          <p className="text-[10px] text-gray-400 mb-0.5">Path</p>
          <p className="font-mono text-gray-700 break-all">{node.id}</p>
        </div>

        <div className="flex gap-4">
          <div>
            <p className="text-[10px] text-gray-400">Language</p>
            <p className="text-gray-700 capitalize">{node.lang || '—'}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-400">In</p>
            <p className="font-mono text-gray-700">{node.inDeg}</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-400">Out</p>
            <p className="font-mono text-gray-700">{node.outDeg}</p>
          </div>
        </div>

        {importedBy.length > 0 && (
          <div>
            <p className="text-[10px] text-gray-400 mb-1">
              Imported by{' '}
              <span className="text-gray-500">{importedBy.length}</span>
            </p>
            <div className="flex flex-col gap-0.5">
              {importedBy.slice(0, 12).map((id) => (
                <p key={id} className="font-mono text-[10px] text-gray-600 truncate" title={id}>
                  {id}
                </p>
              ))}
              {importedBy.length > 12 && (
                <p className="text-[10px] text-gray-400">+{importedBy.length - 12} more</p>
              )}
            </div>
          </div>
        )}

        {imports.length > 0 && (
          <div>
            <p className="text-[10px] text-gray-400 mb-1">
              Imports{' '}
              <span className="text-gray-500">{imports.length}</span>
            </p>
            <div className="flex flex-col gap-0.5">
              {imports.slice(0, 12).map((id) => (
                <p key={id} className="font-mono text-[10px] text-gray-600 truncate" title={id}>
                  {id}
                </p>
              ))}
              {imports.length > 12 && (
                <p className="text-[10px] text-gray-400">+{imports.length - 12} more</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DomainGraphView({ graph }: { graph: DomainGraph }): React.ReactElement {
  const domains = Object.entries(graph.domains);
  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-3">
      {domains.length === 0 ? (
        <p className="text-sm text-gray-400 text-center mt-8">No domains in this graph.</p>
      ) : (
        domains.map(([domainId, domain]) => {
          const reqs = Object.entries(domain.requirements ?? {});
          return (
            <div key={domainId} className="border rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 border-b flex items-center gap-2">
                <span className="text-[11px] font-semibold text-gray-800">{domainId}</span>
                <span className="text-[10px] text-gray-400">{reqs.length} reqs</span>
              </div>
              {domain.description && (
                <p className="text-[11px] text-gray-500 px-4 pt-2 pb-1">{domain.description}</p>
              )}
              {reqs.length > 0 && (
                <div className="divide-y">
                  {reqs.map(([reqId, req]) => (
                    <div key={reqId} className="px-4 py-2">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] font-mono text-gray-400">{reqId}</span>
                        {req.status && (
                          <span
                            className={`text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded ${
                              req.status === 'active'
                                ? 'bg-emerald-100 text-emerald-700'
                                : req.status === 'deprecated'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {req.status}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-700">{req.title}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function ForceGraphContainer({
  nodes,
  edges,
  highlightId,
  onNodeSelect,
}: {
  nodes: CodeGraphData['nodes'];
  edges: CodeGraphData['edges'];
  highlightId: string | null;
  onNodeSelect: (node: CodeGraphNode | null) => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      // Guard: skip 0×0 reports from hidden parent (display:none).
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setDims({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
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
        onNodeSelect={onNodeSelect}
        {...(highlightId !== null ? { externalSelectedId: highlightId } : {})}
      />
    </div>
  );
}

export function RepoGraphModal({ repo, onClose }: Props): React.ReactElement {
  const [tab, setTab] = useState<TabId>('graph');
  const [graphType, setGraphType] = useState<GraphType>('code');
  const [loading, setLoading] = useState(true);
  const [codeData, setCodeData] = useState<CodeGraphData | null>(null);
  const [domainData, setDomainData] = useState<DomainGraph | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<CodeGraphNode | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .getRepoGraph(repo.id)
      .then(({ graph }) => setCodeData(graph))
      .catch(() => setCodeData(null))
      .finally(() => setLoading(false));
  }, [repo.id]);

  useEffect(() => {
    if (graphType !== 'domain' || domainData !== null) return;
    setDomainLoading(true);
    api
      .getRepoDomainGraph(repo.id)
      .then(({ graph }) => setDomainData(graph))
      .catch(() => setDomainData(null))
      .finally(() => setDomainLoading(false));
  }, [graphType, domainData, repo.id]);

  function handleHotspotSelect(node: CodeGraphNode): void {
    setHighlightId(node.id);
    setSelectedNode(node);
    // Stay on hotspots tab — detail panel appears on the right
  }

  function handleNodeSelect(node: CodeGraphNode | null): void {
    setSelectedNode(node);
    if (node !== null) setHighlightId(node.id);
  }

  const codeEmpty = !codeData || codeData.nodes.length === 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[90vw] h-[90vh] bg-white rounded-2xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0">
          <h2 className="text-sm font-semibold text-gray-800 mr-1">{repo.name}</h2>

          <div className="flex gap-0.5 bg-gray-100 rounded p-0.5">
            {(['code', 'domain'] as GraphType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setGraphType(t)}
                className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  graphType === t
                    ? 'bg-white shadow-sm text-gray-800'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'code' ? 'Code' : 'Domain'}
              </button>
            ))}
          </div>

          {graphType === 'code' && (
            <div className="flex gap-0.5 bg-gray-100 rounded p-0.5">
              {(['graph', 'hotspots'] as TabId[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    tab === t
                      ? 'bg-white shadow-sm text-gray-800'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t === 'graph' ? 'Graph' : 'Hotspots'}
                </button>
              ))}
            </div>
          )}

          {codeData && graphType === 'code' && (
            <span className="text-[10px] text-gray-400">
              {codeData.stats.nodeCount} nodes · {codeData.stats.edgeCount} edges
            </span>
          )}

          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-gray-400 hover:text-gray-600 text-2xl leading-none w-8 h-8 flex items-center justify-center"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">Loading…</p>
            </div>
          ) : graphType === 'domain' ? (
            domainLoading ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-gray-400">Loading domain graph…</p>
              </div>
            ) : !domainData ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-gray-400">
                  Domain graph not available — run a governed workflow to generate it.
                </p>
              </div>
            ) : (
              <DomainGraphView graph={domainData} />
            )
          ) : codeEmpty ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-400">
                Code graph not yet available — run onboarding first.
              </p>
            </div>
          ) : (
            /* NodeDetailPanel is shared between both tabs — sits on the right. */
            <div className="h-full flex">
              <div className="flex-1 overflow-hidden">
                {/* Graph tab — stays mounted; inline style beats Tailwind class order. */}
                <div
                  className="h-full overflow-hidden"
                  style={{ display: tab === 'graph' ? 'flex' : 'none' }}
                >
                  <ForceGraphContainer
                    nodes={codeData!.nodes}
                    edges={codeData!.edges}
                    highlightId={highlightId}
                    onNodeSelect={handleNodeSelect}
                  />
                </div>
                {/* Hotspots tab */}
                <div
                  className="h-full overflow-hidden"
                  style={{ display: tab === 'hotspots' ? 'block' : 'none' }}
                >
                  <HotspotsView
                    nodes={codeData!.nodes}
                    selectedId={selectedNode?.id ?? null}
                    onSelect={handleHotspotSelect}
                  />
                </div>
              </div>

              {/* Shared node detail panel */}
              {selectedNode && (
                <NodeDetailPanel
                  node={selectedNode}
                  edges={codeData!.edges}
                  onClose={() => setSelectedNode(null)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
