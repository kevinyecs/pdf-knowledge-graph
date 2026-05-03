import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeKind } from '../lib/extract'

export type EntityNodeData = {
  label: string
  kind: NodeKind
  highlighted?: boolean
  dimmed?: boolean
}

const KIND_STYLES: Record<NodeKind, { dot: string; ring: string; text: string }> = {
  person:  { dot: 'bg-rose-400',    ring: 'ring-rose-400/30',    text: 'text-rose-200' },
  place:   { dot: 'bg-emerald-400', ring: 'ring-emerald-400/30', text: 'text-emerald-200' },
  org:     { dot: 'bg-amber-400',   ring: 'ring-amber-400/30',   text: 'text-amber-200' },
  topic:   { dot: 'bg-accent-soft', ring: 'ring-accent/30',      text: 'text-ink-100' },
  money:   { dot: 'bg-lime-400',    ring: 'ring-lime-400/30',    text: 'text-lime-200' },
  date:    { dot: 'bg-sky-400',     ring: 'ring-sky-400/30',     text: 'text-sky-200' },
  percent: { dot: 'bg-fuchsia-400', ring: 'ring-fuchsia-400/30', text: 'text-fuchsia-200' },
  metric:  { dot: 'bg-cyan-400',    ring: 'ring-cyan-400/30',    text: 'text-cyan-200' },
}

export default function EntityNode({ data, selected }: NodeProps) {
  const d = data as EntityNodeData
  const style = KIND_STYLES[d.kind] ?? KIND_STYLES.topic
  const base = 'group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-all'
  const bg = d.dimmed ? 'bg-ink-800/40' : 'bg-ink-800'
  const border = selected
    ? 'ring-2 ring-accent'
    : d.highlighted
      ? `ring-2 ${style.ring}`
      : 'ring-1 ring-ink-700'

  return (
    <div className={`${base} ${bg} ${border} ${d.dimmed ? 'opacity-50' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      <span className={`whitespace-nowrap ${style.text}`} title={d.label}>
        {truncate(d.label, 28)}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
