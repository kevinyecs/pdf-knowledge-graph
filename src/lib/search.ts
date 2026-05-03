import type { GNode, GEdge } from './extract'

export type SearchHit = {
  nodeId: string
  score: number
}

export function searchNodes(
  nodes: GNode[],
  edges: GEdge[],
  query: string,
): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const tokens = q.split(/\s+/).filter(Boolean)
  const hits: SearchHit[] = []

  for (const n of nodes) {
    const label = n.label.toLowerCase()
    let score = 0
    if (label === q) score += 10
    else if (label.startsWith(q)) score += 5
    else if (label.includes(q)) score += 3

    for (const t of tokens) {
      if (t.length < 2) continue
      if (label.includes(t)) score += 1
    }

    if (score > 0) hits.push({ nodeId: n.id, score })
  }

  // Bonus for highly connected hits, they're usually what people want.
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  for (const h of hits) {
    h.score += Math.min(3, (degree.get(h.nodeId) ?? 0) * 0.2)
  }

  return hits.sort((a, b) => b.score - a.score)
}
