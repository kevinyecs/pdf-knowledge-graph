import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider, type Edge, type Node } from '@xyflow/react'

import Sidebar from './components/Sidebar'
import GraphView from './components/GraphView'
import TextPanel from './components/TextPanel'

import {
  extractRemote, pingBackend,
  type GEdge, type GNode, type Sentence,
} from './lib/extract'
import { searchNodes } from './lib/search'
import { layoutDagre } from './lib/layout'

type Status = 'idle' | 'extracting' | 'ready' | 'error'

export default function App() {
  const [docName, setDocName] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [sentences, setSentences] = useState<Sentence[]>([])

  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])

  // Frozen snapshot of what the backend returned, used so editing the
  // graph never breaks the text panel's mention indices.
  const [extracted, setExtracted] = useState<{ nodes: GNode[]; edges: GEdge[] }>({ nodes: [], edges: [] })

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [backendUp, setBackendUp] = useState<boolean | null>(null)

  // Ping the backend on mount and again whenever we get an error so the
  // sidebar dot reflects reality.
  useEffect(() => {
    let alive = true
    pingBackend().then((up) => { if (alive) setBackendUp(up) })
    const t = setInterval(() => {
      pingBackend().then((up) => { if (alive) setBackendUp(up) })
    }, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const onPickFile = useCallback(async (file: File) => {
    setStatus('extracting')
    setError(null)
    try {
      const resp = await extractRemote(file)
      setDocName(resp.name)
      setPageCount(resp.page_count)
      setExtracted({ nodes: resp.nodes, edges: resp.edges })
      setSentences(resp.sentences)

      const flowNodes: Node[] = resp.nodes.map((n) => ({
        id: n.id,
        type: 'entity',
        position: { x: 0, y: 0 },
        data: { label: n.label, kind: n.kind },
      }))
      const flowEdges: Edge[] = resp.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: e.label === 'co-mentioned',
        style: { strokeWidth: edgeWidth(e.weight, e.label) },
      }))

      const laid = layoutDagre(flowNodes, flowEdges, 'LR')
      setNodes(laid.nodes)
      setEdges(laid.edges)
      setSelectedNodeId(null)
      setSelectedEdgeId(null)
      setStatus('ready')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'extraction failed')
      setStatus('error')
    }
  }, [])

  const hits = useMemo(() => {
    if (!query.trim() || extracted.nodes.length === 0) return []
    const live = nodesAsKG(nodes)
    return searchNodes(live, edgesAsKG(edges), query)
      .map((h) => {
        const node = live.find((n) => n.id === h.nodeId)
        return node ? { node, score: h.score } : null
      })
      .filter((x): x is { node: GNode; score: number } => x !== null)
  }, [query, nodes, edges, extracted.nodes.length])

  const highlightIds = useMemo(() => new Set(hits.slice(0, 12).map((h) => h.node.id)), [hits])

  const selectedEdge: GEdge | null = useMemo(() => {
    if (!selectedEdgeId) return null
    return extracted.edges.find((x) => x.id === selectedEdgeId) ?? null
  }, [selectedEdgeId, extracted.edges])

  const onPickHit = useCallback((id: string) => {
    setSelectedNodeId(id)
    setSelectedEdgeId(null)
  }, [])

  useEffect(() => {
    if (selectedNodeId && !nodes.find((n) => n.id === selectedNodeId)) setSelectedNodeId(null)
    if (selectedEdgeId && !edges.find((e) => e.id === selectedEdgeId)) setSelectedEdgeId(null)
  }, [nodes, edges, selectedNodeId, selectedEdgeId])

  const liveNodesForText = useMemo(() => mergeNodesForText(extracted.nodes, nodes), [extracted.nodes, nodes])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ink-900 text-ink-100">
      <Sidebar
        fileName={docName}
        pageCount={pageCount}
        nodeCount={nodes.length}
        edgeCount={edges.length}
        busy={status === 'extracting'}
        onPickFile={onPickFile}
        query={query}
        onQuery={setQuery}
        hits={hits}
        onPickHit={onPickHit}
        backendUp={backendUp}
      />

      <main className="relative flex-1">
        {status === 'idle' && nodes.length === 0 && <EmptyState backendUp={backendUp} />}
        {status === 'error' && (
          <div className="absolute inset-x-0 top-0 z-10 bg-rose-900/40 text-rose-100 text-xs px-4 py-2">
            {error}
          </div>
        )}

        <ReactFlowProvider>
          <GraphView
            nodes={nodes}
            edges={edges}
            setNodes={setNodes}
            setEdges={setEdges}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectNode={(id) => { setSelectedNodeId(id); setSelectedEdgeId(null) }}
            onSelectEdge={(id) => { setSelectedEdgeId(id); setSelectedNodeId(null) }}
            highlightIds={highlightIds}
          />
        </ReactFlowProvider>
      </main>

      <TextPanel
        sentences={sentences}
        nodes={liveNodesForText}
        selectedNodeId={selectedNodeId}
        selectedEdge={selectedEdge}
        query={query}
      />
    </div>
  )
}

function EmptyState({ backendUp }: { backendUp: boolean | null }) {
  return (
    <div className="absolute inset-0 grid place-items-center pointer-events-none">
      <div className="text-center">
        <div className="text-3xl tracking-tight text-ink-300">Nothing loaded yet</div>
        <p className="mt-2 text-sm text-ink-400">
          {backendUp === false
            ? 'Backend is offline, start it with `uvicorn app:app --reload` from backend/.'
            : 'Pick a PDF on the left. A short one (a few pages) works best.'}
        </p>
      </div>
    </div>
  )
}

function edgeWidth(weight: number, label: string): number {
  if (label === 'co-mentioned') return 1
  return Math.min(3.5, 1.2 + Math.log2(1 + weight))
}

function nodesAsKG(nodes: Node[]): GNode[] {
  return nodes.map((n) => {
    const data = n.data as { label?: unknown; kind?: unknown } | undefined
    return {
      id: n.id,
      label: typeof data?.label === 'string' ? data.label : n.id,
      kind: (data?.kind as GNode['kind']) ?? 'topic',
      score: 0,
      mentions: [],
    }
  })
}

function edgesAsKG(edges: Edge[]): GEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: typeof e.label === 'string' ? e.label : '',
    sentence: -1,
    weight: 1,
  }))
}

function mergeNodesForText(originals: GNode[], live: Node[]): GNode[] {
  const byId = new Map(originals.map((n) => [n.id, n]))
  return live.map((n) => {
    const base = byId.get(n.id)
    const data = n.data as { label?: unknown; kind?: unknown } | undefined
    const label = typeof data?.label === 'string' ? data.label : n.id
    const kind = (data?.kind as GNode['kind']) ?? 'topic'
    return base
      ? { ...base, label, kind }
      : { id: n.id, label, kind, score: 0, mentions: [] }
  })
}
