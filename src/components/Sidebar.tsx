import { useRef } from 'react'
import type { GNode } from '../lib/extract'

type Props = {
  fileName: string | null
  pageCount: number
  nodeCount: number
  edgeCount: number
  busy: boolean
  onPickFile: (file: File) => void
  query: string
  onQuery: (q: string) => void
  hits: { node: GNode; score: number }[]
  onPickHit: (id: string) => void
  backendUp: boolean | null
}

export default function Sidebar(props: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-ink-700 bg-ink-900/80">
      <div className="px-4 pt-4 pb-3 border-b border-ink-700">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <h1 className="text-sm font-semibold tracking-tight text-ink-100">PDF Knowledge Graph</h1>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
          Drop a short PDF, get an editable graph of who/what/where it talks about.
        </p>
      </div>

      <div className="px-4 py-3 border-b border-ink-700">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) props.onPickFile(f)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={props.busy || props.backendUp === false}
          className="w-full rounded-md bg-accent/90 px-3 py-2 text-sm font-medium text-white transition hover:bg-accent disabled:opacity-50"
        >
          {props.busy ? 'Working…' : props.fileName ? 'Replace PDF' : 'Upload PDF'}
        </button>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-400">
          <span className={`h-1.5 w-1.5 rounded-full ${props.backendUp == null ? 'bg-ink-400 animate-pulse' : props.backendUp ? 'bg-emerald-400' : 'bg-rose-400'}`} />
          backend {props.backendUp == null ? 'checking' : props.backendUp ? 'online' : 'offline (run uvicorn)'}
        </div>
        {props.fileName && (
          <div className="mt-3 space-y-1 text-[11px] text-ink-400">
            <div className="truncate"><span className="text-ink-300">file</span>  ·  {props.fileName}</div>
            <div><span className="text-ink-300">pages</span>  ·  {props.pageCount}</div>
            <div>
              <span className="text-ink-300">graph</span>  ·  {props.nodeCount} nodes, {props.edgeCount} edges
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-b border-ink-700">
        <label className="block text-[11px] uppercase tracking-wide text-ink-400 mb-1">Search</label>
        <input
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder="filter nodes…"
          className="w-full rounded-md bg-ink-800 border border-ink-700 px-2.5 py-1.5 text-sm placeholder:text-ink-400 focus:border-accent focus:outline-none"
        />
        <div className="mt-2 max-h-64 overflow-y-auto scroll-thin">
          {props.hits.length === 0 && props.query && (
            <div className="text-[11px] text-ink-400 py-2">no matches</div>
          )}
          {props.hits.slice(0, 30).map(({ node, score }) => (
            <button
              key={node.id}
              onClick={() => props.onPickHit(node.id)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-ink-800"
            >
              <span className="flex items-center gap-2 truncate">
                <span className={`h-1.5 w-1.5 rounded-full ${kindDot(node.kind)}`} />
                <span className="truncate">{node.label}</span>
              </span>
              <span className="text-ink-400 tabular-nums">{score.toFixed(1)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-auto px-4 py-3 text-[10px] text-ink-500 leading-relaxed">
        Tips: drag nodes to rearrange. Drag from a handle to connect. Double-click to rename. Pick a node to see the source sentences on the right.
      </div>
    </aside>
  )
}

function kindDot(kind: string): string {
  switch (kind) {
    case 'person':  return 'bg-rose-400'
    case 'place':   return 'bg-emerald-400'
    case 'org':     return 'bg-amber-400'
    case 'money':   return 'bg-lime-400'
    case 'date':    return 'bg-sky-400'
    case 'percent': return 'bg-fuchsia-400'
    case 'metric':  return 'bg-cyan-400'
    default:        return 'bg-accent-soft'
  }
}
