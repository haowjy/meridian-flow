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
    // Dev-only function may not exist in all builds - handle gracefully
    const update = () => {
      try {
        setEntries(getRetryQueueState() || [])
      } catch {
        // Function may not be available - ignore silently
        setEntries([])
      }
    }
    update()
    const t = setInterval(update, 1000)
    return () => clearInterval(t)
  }, [])

  const count = entries.length
  const badge = useMemo(() => (
    <button
      type="button"
      onClick={() => setCollapsed((v) => !v)}
      className="rounded-full bg-accent/90 hover:bg-accent text-accent-foreground px-3 py-1 text-xs shadow-[var(--shadow-1)]"
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
    <div className="fixed left-4 bottom-4 z-50 w-80 rounded-lg border border-border bg-popover/95 text-popover-foreground backdrop-blur-sm p-3 shadow-[var(--shadow-3)]">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-foreground">Retry Queue</div>
        {badge}
      </div>
      {entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">Empty</div>
      ) : (
        <ul className="space-y-2 max-h-56 overflow-auto">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{e.id}</div>
                <div className="text-muted-foreground">attempt {e.attempt} • next in {fmtEta(e.nextAt)}</div>
              </div>
              <button
                type="button"
                onClick={() => cancelRetry(e.id)}
                className="shrink-0 rounded bg-muted hover:bg-muted/80 text-muted-foreground px-2 py-1"
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
