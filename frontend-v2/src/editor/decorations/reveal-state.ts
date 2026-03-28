import { StateEffect, StateField } from "@codemirror/state"

/**
 * Effect to reveal an element's raw markdown source ("Show Raw").
 * Dispatched by double-click, context menu, or keyboard activation.
 */
export const revealElement = StateEffect.define<{ from: number; to: number }>()

/**
 * Effect to conceal a previously revealed element.
 * Dispatched by Escape or explicit conceal action.
 */
export const concealElement = StateEffect.define<{ from: number; to: number }>()

/**
 * Check if a ViewUpdate contains reveal or conceal effects.
 * ViewPlugins that read revealState should rebuild when this returns true.
 */
export function hasRevealEffects(update: { transactions: readonly { effects: readonly StateEffect<unknown>[] }[] }): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(revealElement) || e.is(concealElement))
  )
}

/**
 * StateField tracking which element ranges are currently in "Show Raw" mode.
 *
 * Lifecycle:
 * - Persists across blur (NOT cleared by focus loss) so context menu
 *   interactions don't collapse revealed elements
 * - Auto-conceals when cursor/selection moves entirely outside all
 *   revealed ranges
 * - Maps ranges through document changes on EVERY transaction so
 *   remote Yjs edits don't cause Show Raw to apply to wrong positions
 * - Cleared by Escape or explicit concealElement effect
 */
export const revealState = StateField.define<Set<string>>({
  create: () => new Set(),
  update(revealed, tr) {
    let next = revealed

    for (const effect of tr.effects) {
      if (effect.is(revealElement)) {
        next = new Set(next)
        next.add(`${effect.value.from}-${effect.value.to}`)
      }
      if (effect.is(concealElement)) {
        next = new Set(next)
        next.delete(`${effect.value.from}-${effect.value.to}`)
      }
    }

    // Map revealed ranges through doc changes on EVERY transaction.
    // Remote Yjs edits shift positions even without local selection changes.
    // Without this, Show Raw applies to wrong ranges after accumulated edits.
    if (tr.docChanged && next.size > 0) {
      const mapped = new Set<string>()
      for (const key of next) {
        const [from, to] = key.split("-").map(Number)
        const mappedFrom = tr.changes.mapPos(from)
        const mappedTo = tr.changes.mapPos(to)
        mapped.add(`${mappedFrom}-${mappedTo}`)
      }
      next = mapped
    }

    // Auto-conceal when cursor/selection moves outside all revealed ranges.
    // tr.selection is defined when the transaction explicitly sets a selection.
    // Check ALL selection ranges (not just main) to support multi-cursor editing.
    if (tr.selection && next.size > 0) {
      const ranges = tr.state.selection.ranges
      const stillRevealed = new Set<string>()
      for (const key of next) {
        const [from, to] = key.split("-").map(Number)
        // Keep revealed if ANY selection range intersects this revealed range
        for (const sel of ranges) {
          if (sel.from >= from && sel.to <= to) {
            stillRevealed.add(key)
            break
          }
        }
      }
      next = stillRevealed
    }

    return next
  },
})
