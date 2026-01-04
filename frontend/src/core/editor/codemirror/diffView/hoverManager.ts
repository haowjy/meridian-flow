/**
 * Hunk Hover Manager
 *
 * SRP: Only responsible for showing/hiding hunk action buttons on hover.
 * Uses event delegation on the editor content to track mouse enter/leave
 * on elements with [data-hunk-id] attributes.
 *
 * Why JS instead of CSS?
 * CSS sibling selector `~` selects ALL following siblings.
 * When multiple hunks are on one line, hovering one would show all action buttons.
 * JS allows us to show only the specific hunk's actions.
 */

import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

// =============================================================================
// HOVER MANAGER
// =============================================================================

/**
 * ViewPlugin that manages hover visibility for hunk action buttons.
 *
 * Listens for mouseenter/mouseleave on [data-hunk-id] elements and
 * adds/removes the .visible class on the matching .cm-hunk-actions widget.
 */
class HunkHoverManager {
  private currentHunkId: string | null = null

  constructor(private view: EditorView) {
    this.setupListeners()
  }

  /**
   * Clear hover state when document changes (e.g., accept/reject removes hunk).
   */
  update(update: ViewUpdate) {
    if (update.docChanged && this.currentHunkId) {
      this.hideActions(this.currentHunkId)
      this.currentHunkId = null
    }
  }

  private setupListeners() {
    const content = this.view.contentDOM

    // Use capture phase to catch events on child elements
    content.addEventListener('mouseenter', this.handleEnter, true)
    content.addEventListener('mouseleave', this.handleLeave, true)
    content.addEventListener('mousemove', this.handleMove, true)
  }

  /**
   * Handle mouseenter on any element.
   * If the element (or its ancestor) has [data-hunk-id], show that hunk's actions
   * positioned above the hovered span.
   */
  private handleEnter = (e: Event) => {
    const target = e.target as HTMLElement

    // Check if entering action buttons - keep visible but don't reposition
    if (target.closest('.cm-hunk-actions')) return

    const hunkElement = target.closest('[data-hunk-id]') as HTMLElement | null

    if (!hunkElement) return

    const hunkId = hunkElement.getAttribute('data-hunk-id')!

    // Hide previous hunk's actions (if different hunk)
    if (this.currentHunkId && this.currentHunkId !== hunkId) {
      this.hideActions(this.currentHunkId)
    }

    // Show actions positioned near the hovered element
    this.showActionsNear(hunkId, hunkElement)
  }

  /**
   * Handle mouseleave on any element.
   * Hide actions unless moving to action buttons or same hunk.
   */
  private handleLeave = (e: Event) => {
    const related = (e as MouseEvent).relatedTarget as HTMLElement | null

    // Don't hide if moving to action buttons or same hunk
    if (related) {
      if (related.closest('.cm-hunk-actions')) return
      const relatedHunkId = related.closest('[data-hunk-id]')?.getAttribute('data-hunk-id')
      if (relatedHunkId === this.currentHunkId) return
    }

    // Hide immediately
    if (this.currentHunkId) {
      this.hideActions(this.currentHunkId)
      this.currentHunkId = null
    }
  }

  /**
   * Handle mousemove to update position as cursor moves within hunk.
   */
  private handleMove = (e: MouseEvent) => {
    if (!this.currentHunkId) return

    const target = e.target as HTMLElement

    // Don't move if hovering over action buttons (so user can click them)
    if (target.closest('.cm-hunk-actions')) return

    const hunkElement = target.closest('[data-hunk-id]') as HTMLElement | null

    if (!hunkElement || hunkElement.getAttribute('data-hunk-id') !== this.currentHunkId) return

    // Update horizontal position based on mouse X (fixed positioning uses viewport coords)
    const actions = this.view.contentDOM.querySelector(
      `.cm-hunk-actions[data-hunk-id="${this.currentHunkId}"]`
    ) as HTMLElement | null

    if (!actions) return

    const centerOffset = actions.offsetWidth / 2
    actions.style.left = `${e.clientX - centerOffset}px`
  }

  /**
   * Show actions positioned above the hovered element.
   * Uses fixed positioning with viewport coordinates.
   */
  private showActionsNear(hunkId: string, nearElement: HTMLElement) {
    const actions = this.view.contentDOM.querySelector(
      `.cm-hunk-actions[data-hunk-id="${hunkId}"]`
    ) as HTMLElement | null

    if (!actions) return

    this.currentHunkId = hunkId
    actions.classList.add('visible')

    // Position fixed relative to viewport (centered above span)
    const rect = nearElement.getBoundingClientRect()
    const centerOffset = actions.offsetWidth / 2
    const spanCenterX = rect.left + rect.width / 2

    actions.style.left = `${spanCenterX - centerOffset}px`
    actions.style.top = `${rect.top - actions.offsetHeight}px`
  }

  private hideActions(hunkId: string) {
    const actions = this.view.contentDOM.querySelector(
      `.cm-hunk-actions[data-hunk-id="${hunkId}"]`
    ) as HTMLElement | null

    if (actions) {
      actions.classList.remove('visible')
      actions.style.left = ''
      actions.style.top = ''
    }
  }

  destroy() {
    this.view.contentDOM.removeEventListener('mouseenter', this.handleEnter, true)
    this.view.contentDOM.removeEventListener('mouseleave', this.handleLeave, true)
    this.view.contentDOM.removeEventListener('mousemove', this.handleMove, true)
  }
}

// =============================================================================
// EXPORT
// =============================================================================

export const hunkHoverPlugin = ViewPlugin.fromClass(HunkHoverManager)
