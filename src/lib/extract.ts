// Public types match the backend's JSON response shape (backend/extractor.py).
// The frontend now does no NLP, it just renders what comes back.

export type NodeKind =
  | 'person' | 'place' | 'org' | 'topic'
  | 'money'  | 'date'  | 'percent' | 'metric'

export type GNode = {
  id: string
  label: string
  kind: NodeKind
  score: number
  mentions: number[]
}

export type GEdge = {
  id: string
  source: string
  target: string
  label: string
  sentence: number
  weight: number
}

export type Sentence = {
  index: number
  page: number
  text: string
}

export type ExtractResponse = {
  name: string
  page_count: number
  tabular_pages: number[]
  nodes: GNode[]
  edges: GEdge[]
  sentences: Sentence[]
}

export type KGraph = {
  nodes: GNode[]
  edges: GEdge[]
  sentences: Sentence[]
}

const API_BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '/api'

export async function extractRemote(file: File): Promise<ExtractResponse> {
  const fd = new FormData()
  fd.append('file', file)

  const res = await fetch(`${API_BASE}/extract`, { method: 'POST', body: fd })

  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch { /* not JSON */ }
    throw new Error(`backend returned ${res.status}: ${detail}`)
  }

  return res.json()
}

export async function pingBackend(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`)
    return res.ok
  } catch {
    return false
  }
}
