/**
 * Inline Accept/Reject Buttons Widget
 *
 * SRP: Only renders ✓/✕ buttons and dispatches transactions.
 * Pattern follows MarkerWidget in plugin.ts.
 *
 * These buttons appear at the end of each hunk (after INS_END marker).
 * Clicking them dispatches CM6 transactions, which are undoable via Cmd+Z.
 */

import { WidgetType, type EditorView } from '@codemirror/view'
import { acceptHunk, rejectHunk } from './transactions'

// =============================================================================
// WIDGET
// =============================================================================

/**
 * Widget that displays ✓/✕ buttons at the end of a hunk.
 *
 * CSS classes:
 * - .cm-hunk-actions: Container (hidden by default, shown on hover via JS)
 * - .cm-hunk-accept: Accept button (green on hover)
 * - .cm-hunk-reject: Reject button (red on hover)
 *
 * Data attributes:
 * - data-hunk-id: Links widget to its hunk (used by hoverManager.ts)
 *
 * @see globals.css for CSS styles
 * @see hoverManager.ts for hover visibility logic
 */
export class HunkActionWidget extends WidgetType {
  constructor(
    private readonly hunkId: string,
    private readonly view: EditorView
  ) {
    super()
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span')
    container.className = 'cm-hunk-actions'
    container.dataset.hunkId = this.hunkId

    // Reject button (first, matching floating pill order)
    const rejectBtn = document.createElement('button')
    rejectBtn.textContent = 'Reject ✕'
    rejectBtn.className = 'cm-hunk-reject'
    rejectBtn.title = 'Reject this change'
    rejectBtn.type = 'button'
    rejectBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      rejectHunk(this.view, this.hunkId)
      this.view.focus()
    }

    // Accept button
    const acceptBtn = document.createElement('button')
    acceptBtn.textContent = 'Accept ✓'
    acceptBtn.className = 'cm-hunk-accept'
    acceptBtn.title = 'Accept this change'
    acceptBtn.type = 'button' // Prevent form submission if inside a form
    acceptBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      acceptHunk(this.view, this.hunkId)
      // Restore focus to editor after button click
      this.view.focus()
    }

    container.appendChild(rejectBtn)
    container.appendChild(acceptBtn)

    return container
  }

  /**
   * Widget equality check.
   * Returns false if hunkId differs, triggering re-render.
   */
  eq(other: HunkActionWidget): boolean {
    return other.hunkId === this.hunkId
  }

  /**
   * Tell CodeMirror to ignore events on this widget.
   * The buttons handle their own click events; CM6 shouldn't
   * interfere with selection/cursor changes.
   */
  ignoreEvent(): boolean {
    return true
  }
}
