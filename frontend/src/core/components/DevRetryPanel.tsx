'use client'

import { useEffect, useMemo, useState } from 'react'
import { getRetryQueueState, cancelRetry } from '@/core/lib/sync'

type Entry = { id: string; attempt: number; nextAt: number }

function fmtEta(nextAt: number): string {
  const ms = Math.max(0, nextAt - Date.now())
  const s = Math.ceil(ms / 1000)
  return `${s}s`
}

export function DevRetryPanel() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    const update = () => setEntries(getRetryQueueState() || [])
    update()
    const t = setInterval(update, 1000)
    return () => clearInterval(t)
  }, [])

  const count = entries.length
  const badge = useMemo(() => (
    <button
      type="button"
      onClick={() => setCollapsed((v) => !v)}
      className="rounded-full bg-indigo-600/90 hover:bg-indigo-600 text-white px-3 py-1 text-xs shadow"
    >
      Retries: {count}
    </button>
  ), [count])

  if (collapsed) {
    return (
      <div className="fixed left-4 bottom-4 z-50">
        {badge}
      </div>
    )
  }

  return (
    <div className="fixed left-4 bottom-4 z-50 w-80 rounded-md border border-zinc-800/60 bg-zinc-900/90 text-zinc-100 backdrop-blur p-3 shadow-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase tracking-wide">Retry Queue</div>
        {badge}
      </div>
      {entries.length === 0 ? (
        <div className="text-xs text-zinc-400">Empty</div>
      ) : (
        <ul className="space-y-2 max-h-56 overflow-auto">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium">{e.id}</div>
                <div className="text-zinc-400">attempt {e.attempt} • next in {fmtEta(e.nextAt)}</div>
              </div>
              <button
                type="button"
                onClick={() => cancelRetry(e.id)}
                className="shrink-0 rounded bg-zinc-800 hover:bg-zinc-700 px-2 py-1"
                aria-label={`Cancel retry ${e.id}`}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

