import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import EntityNode from './EntityNode'
import { layoutDagre } from '../lib/layout'

type Props = {
  nodes: Node[]
  edges: Edge[]
  setNodes: (updater: (nodes: Node[]) => Node[]) => void
  setEdges: (updater: (edges: Edge[]) => Edge[]) => void
  selectedNodeId: string | null
  selectedEdgeId: string | null
  onSelectNode: (id: string | null) => void
  onSelectEdge: (id: string | null) => void
  highlightIds: Set<string>
}

const nodeTypes = { entity: EntityNode }

export default function GraphView(props: Props) {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    selectedNodeId,
    selectedEdgeId,
    onSelectNode,
    onSelectEdge,
    highlightIds,
  } = props

  const rfRef = useRef<ReactFlowInstance | null>(null)

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [setNodes],
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [setEdges],
  )

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge(
          {
            ...c,
            id: `m-${Date.now()}`,
            label: 'related',
            data: { manual: true },
          },
          es,
        ),
      ),
    [setEdges],
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => onSelectNode(node.id),
    [onSelectNode],
  )

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_evt, edge) => onSelectEdge(edge.id),
    [onSelectEdge],
  )

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      const next = window.prompt('Rename node', String(node.data?.label ?? ''))
      if (next == null) return
      const trimmed = next.trim()
      if (!trimmed) return
      setNodes((ns) =>
        ns.map((n) =>
          n.id === node.id ? { ...n, data: { ...n.data, label: trimmed } } : n,
        ),
      )
    },
    [setNodes],
  )

  const onEdgeDoubleClick: EdgeMouseHandler = useCallback(
    (_evt, edge) => {
      const next = window.prompt('Rename edge', String(edge.label ?? ''))
      if (next == null) return
      setEdges((es) =>
        es.map((e) => (e.id === edge.id ? { ...e, label: next } : e)),
      )
    },
    [setEdges],
  )

  const handleAddNode = () => {
    const label = window.prompt('New node label')
    if (!label) return
    const trimmed = label.trim()
    if (!trimmed) return
    const id = `manual:${trimmed.toLowerCase()}:${Date.now()}`

    // Drop it near the current viewport center so it's actually visible.
    const inst = rfRef.current
    let position = { x: 0, y: 0 }
    if (inst) {
      const center = inst.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      })
      position = center
    }

    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'entity',
        position,
        data: { label: trimmed, kind: 'topic' },
      },
    ])
  }

  const handleDelete = () => {
    if (selectedNodeId) {
      setNodes((ns) => ns.filter((n) => n.id !== selectedNodeId))
      setEdges((es) => es.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId))
      onSelectNode(null)
    } else if (selectedEdgeId) {
      setEdges((es) => es.filter((e) => e.id !== selectedEdgeId))
      onSelectEdge(null)
    }
  }

  const handleRelayout = () => {
    const laid = layoutDagre(nodes, edges, 'LR')
    setNodes(() => laid.nodes)
    setEdges(() => laid.edges)
    setTimeout(() => rfRef.current?.fitView({ padding: 0.2, duration: 300 }), 50)
  }

  // When highlights change, gently zoom to the first match.
  useEffect(() => {
    if (!rfRef.current || highlightIds.size === 0) return
    const first = nodes.find((n) => highlightIds.has(n.id))
    if (!first) return
    rfRef.current.setCenter(
      first.position.x + 80,
      first.position.y + 22,
      { zoom: 1.2, duration: 400 },
    )
  }, [highlightIds, nodes])

  const decorated = useMemo(() => {
    if (highlightIds.size === 0) return nodes
    return nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        highlighted: highlightIds.has(n.id),
        dimmed: !highlightIds.has(n.id),
      },
    }))
  }, [nodes, highlightIds])

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={decorated}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onPaneClick={() => { onSelectNode(null); onSelectEdge(null) }}
        onInit={(inst) => { rfRef.current = inst }}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272d" gap={22} />
        <MiniMap
          maskColor="rgba(16,16,20,0.7)"
          nodeColor={(n) => kindColor(String((n.data as { kind?: string } | undefined)?.kind ?? 'topic'))}
          pannable
          zoomable
        />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="absolute right-3 top-3 flex gap-2">
        <button onClick={handleAddNode} className="btn-toolbar">+ Node</button>
        <button onClick={handleDelete} disabled={!selectedNodeId && !selectedEdgeId} className="btn-toolbar disabled:opacity-40">
          Delete
        </button>
        <button onClick={handleRelayout} className="btn-toolbar">Re-layout</button>
      </div>

      <style>{`
        .btn-toolbar {
          background: #1a1a1f;
          color: #eeeef1;
          border: 1px solid #27272d;
          padding: 6px 10px;
          font-size: 12px;
          border-radius: 6px;
        }
        .btn-toolbar:hover { background: #27272d; }
      `}</style>
    </div>
  )
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'person': return '#fb7185'
    case 'place':  return '#34d399'
    case 'org':    return '#fbbf24'
    default:       return '#a892ff'
  }
}
