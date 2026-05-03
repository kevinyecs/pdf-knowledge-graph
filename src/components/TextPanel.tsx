import { useEffect, useMemo, useRef } from 'react'
import type { GEdge, GNode, Sentence } from '../lib/extract'

type Props = {
  sentences: Sentence[]
  nodes: GNode[]
  selectedNodeId: string | null
  selectedEdge: GEdge | null
  query: string
}

export default function TextPanel(props: Props) {
  const { sentences, nodes, selectedNodeId, selectedEdge, query } = props
  const ref = useRef<HTMLDivElement>(null)

  const focusSentences = useMemo(() => {
    if (selectedEdge) return new Set([selectedEdge.sentence])
    if (selectedNodeId) {
      const n = nodes.find((x) => x.id === selectedNodeId)
      return new Set(n?.mentions ?? [])
    }
    return new Set<number>()
  }, [selectedNodeId, selectedEdge, nodes])

  const selectedLabel = useMemo(() => {
    if (selectedEdge) return null
    return nodes.find((n) => n.id === selectedNodeId)?.label ?? null
  }, [selectedNodeId, selectedEdge, nodes])

  // Keep focus on the first relevant sentence so users land on context, not page top.
  useEffect(() => {
    if (!ref.current) return
    const first = ref.current.querySelector('[data-focus="true"]') as HTMLElement | null
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [selectedNodeId, selectedEdge])

  if (sentences.length === 0) {
    return (
      <section className="flex h-full w-[28rem] shrink-0 flex-col border-l border-ink-700 bg-ink-900/80">
        <header className="border-b border-ink-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">Source text</h2>
          <p className="mt-1 text-[11px] text-ink-400">Read-only. Click a node or edge to jump here.</p>
        </header>
        <div className="flex-1 grid place-items-center text-xs text-ink-400 px-6 text-center">
          Upload a PDF to populate the graph and source text.
        </div>
      </section>
    )
  }

  return (
    <section className="flex h-full w-[28rem] shrink-0 flex-col border-l border-ink-700 bg-ink-900/80">
      <header className="border-b border-ink-700 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-100">Source text</h2>
        <p className="mt-1 text-[11px] text-ink-400">
          {selectedEdge
            ? <>Showing the sentence that produced this edge.</>
            : selectedLabel
              ? <>Mentions of <span className="text-ink-200">{selectedLabel}</span></>
              : <>Click a node or edge to jump to its source. Editing the graph never touches this text.</>}
        </p>
      </header>

      <div ref={ref} className="flex-1 overflow-y-auto scroll-thin px-4 py-3 space-y-3 text-[13px] leading-relaxed">
        {sentences.map((s) => {
          const isFocus = focusSentences.has(s.index)
          return (
            <p
              key={s.index}
              data-focus={isFocus ? 'true' : undefined}
              className={
                'rounded-md px-3 py-2 transition ' +
                (isFocus
                  ? 'bg-ink-800 ring-1 ring-accent/60 text-ink-100'
                  : focusSentences.size > 0
                    ? 'text-ink-400 hover:text-ink-200'
                    : 'text-ink-200')
              }
            >
              <span className="mr-2 select-none rounded bg-ink-800 px-1.5 py-0.5 text-[10px] tabular-nums text-ink-400">
                p.{s.page}
              </span>
              {highlight(s.text, query, selectedLabel)}
            </p>
          )
        })}
      </div>
    </section>
  )
}

function highlight(text: string, q: string, label: string | null) {
  const terms = [label, q]
    .filter((t): t is string => !!t && t.trim().length > 1)
    .map((t) => t.trim().toLowerCase())
  if (terms.length === 0) return text

  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(re)
  const lower = new Set(terms)

  return parts.map((part, i) =>
    lower.has(part.toLowerCase())
      ? <mark key={i} className="kg-hit">{part}</mark>
      : <span key={i}>{part}</span>,
  )
}
