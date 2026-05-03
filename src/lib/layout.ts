import dagre from 'dagre'
import { Position, type Node, type Edge } from '@xyflow/react'

const NODE_W = 170
const NODE_H = 44

export function layoutDagre(
  nodes: Node[],
  edges: Edge[],
  direction: 'LR' | 'TB' = 'LR',
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 80 })

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of edges) g.setEdge(e.source, e.target)

  dagre.layout(g)

  const placed: Node[] = nodes.map((n) => {
    const { x, y } = g.node(n.id)
    return {
      ...n,
      position: { x: x - NODE_W / 2, y: y - NODE_H / 2 },
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
      targetPosition: direction === 'LR' ? Position.Left : Position.Top,
    }
  })

  return { nodes: placed, edges }
}
