/**
 * Hunk Hover Manager
 *
 * SRP: Only responsible for showing/hiding + positioning the hunk action pill.
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
 * adds/removes the .visible class on the matching .cm-hunk-actions widget,
 * while keeping the pill positioned above the current hunk.
 */
class HunkHoverManager {
  private currentHunkId: string | null = null
  private currentAnchorEl: HTMLElement | null = null
  private pendingRepositionFrame: number | null = null

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

    // Keep the pill aligned on layout changes (e.g., wrapping on resize).
    if ((update.geometryChanged || update.viewportChanged) && this.currentHunkId) {
      this.requestReposition()
    }
  }

  private setupListeners() {
    const content = this.view.contentDOM

    // Use capture phase to catch events on child elements
    content.addEventListener('mouseenter', this.handleEnter, true)
    content.addEventListener('mouseleave', this.handleLeave, true)
    content.addEventListener('mousemove', this.handleMove, true)

    window.addEventListener('resize', this.handleResize, { passive: true })
  }

  /**
   * Handle mouseenter on any element.
   * If the element (or its ancestor) has [data-hunk-id], show that hunk's actions
   * positioned above the hovered span.
   *
   * BOUNDARY: Skips focused widgets entirely - they're handled by CodeMirror.
   */
  private handleEnter = (e: Event) => {
    const target = e.target as HTMLElement

    // Check if entering action buttons - keep visible but don't reposition
    if (target.closest('.cm-hunk-actions')) return

    const hunkElement = target.closest('[data-hunk-id]') as HTMLElement | null

    if (!hunkElement) return

    const hunkId = hunkElement.getAttribute('data-hunk-id')!

    // Check if this hunk's widget is focused - if so, skip entirely
    // Focused widgets are positioned inline by CodeMirror, not by hover manager
    const actions = this.view.contentDOM.querySelector(
      `.cm-hunk-actions[data-hunk-id="${hunkId}"]`
    ) as HTMLElement | null
    if (actions?.classList.contains('cm-hunk-focused-visible')) return

    // Hide previous hunk's actions (if different hunk)
    if (this.currentHunkId && this.currentHunkId !== hunkId) {
      this.hideActions(this.currentHunkId)
    }

    // Show actions positioned near the hovered element
    this.currentAnchorEl = hunkElement
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
   * Updates both horizontal (follows mouse X) and vertical (follows anchor element).
   *
   * BOUNDARY: Skips focused widgets - they're handled by CodeMirror.
   */
  private handleMove = (e: MouseEvent) => {
    if (!this.currentHunkId) return

    const target = e.target as HTMLElement

    // Don't move if hovering over action buttons (so user can click them)
    if (target.closest('.cm-hunk-actions')) return

    const hunkElement = target.closest('[data-hunk-id]') as HTMLElement | null

    if (!hunkElement || hunkElement.getAttribute('data-hunk-id') !== this.currentHunkId) return

    // Track if anchor changed (for vertical repositioning)
    const anchorChanged = this.currentAnchorEl !== hunkElement
    this.currentAnchorEl = hunkElement

    // Update horizontal position based on mouse X.
    const actions = this.view.contentDOM.querySelector(
      `.cm-hunk-actions[data-hunk-id="${this.currentHunkId}"]`
    ) as HTMLElement | null

    if (!actions) return

    // Skip focused widgets - they might have become focused after hover started
    if (actions.classList.contains('cm-hunk-focused-visible')) return

    const container = (actions.offsetParent ?? this.view.contentDOM) as HTMLElement
    const containerRect = container.getBoundingClientRect()
    const centerOffset = actions.offsetWidth / 2
    actions.style.left = `${e.clientX - containerRect.left - centerOffset}px`

    // Also update vertical position when anchor element changes
    // This ensures buttons follow cursor vertically in large multi-line hunks
    if (anchorChanged) {
      this.requestReposition()
    }
  }

  private handleResize = () => {
    if (!this.currentHunkId) return
    this.requestReposition()
  }

  private requestReposition() {
    if (this.pendingRepositionFrame !== null) return
    this.pendingRepositionFrame = window.requestAnimationFrame(() => {
      this.pendingRepositionFrame = null
      this.repositionCurrent()
    })
  }

  private repositionCurrent() {
    if (!this.currentHunkId) return

    const actions = this.view.contentDOM.querySelector(
      `.cm-hunk-actions[data-hunk-id="${this.currentHunkId}"]`
    ) as HTMLElement | null

    if (!actions) return

    // Skip focused widgets - they're positioned inline by CodeMirror
    if (actions.classList.contains('cm-hunk-focused-visible')) return

    if (!actions.classList.contains('visible')) return

    const anchor =
      this.currentAnchorEl ??
      (this.view.contentDOM.querySelector(
        `[data-hunk-id="${this.currentHunkId}"]`
      ) as HTMLElement | null)

    if (!anchor) {
      this.hideActions(this.currentHunkId)
      this.currentHunkId = null
      return
    }

    const container = (actions.offsetParent ?? this.view.contentDOM) as HTMLElement
    const containerRect = container.getBoundingClientRect()
    const rect = anchor.getBoundingClientRect()

    // If the anchor is fully off-screen, hiding avoids a "detached" pill.
    if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) {
      this.hideActions(this.currentHunkId)
      this.currentHunkId = null
      return
    }

    const centerOffset = actions.offsetWidth / 2
    const spanCenterX = rect.left + rect.width / 2 - containerRect.left
    const anchorTop = rect.top - containerRect.top

    actions.style.left = `${spanCenterX - centerOffset}px`
    actions.style.top = `${anchorTop - actions.offsetHeight}px`
  }

  /**
   * Show actions positioned above the hovered element.
   * Uses absolute positioning within the editor content DOM.
   *
   * BOUNDARY: Skips focused widgets - they're positioned inline by CodeMirror
   * and should not be touched by the hover manager.
   */
  private showActionsNear(hunkId: string, nearElement: HTMLElement) {
    const actions = this.view.contentDOM.querySelector(
      `.cm-hunk-actions[data-hunk-id="${hunkId}"]`
    ) as HTMLElement | null

    if (!actions) return

    // Skip focused widgets - they're positioned inline by CodeMirror
    if (actions.classList.contains('cm-hunk-focused-visible')) return

    this.currentHunkId = hunkId
    this.currentAnchorEl = nearElement
    actions.classList.add('visible')

    // Defer positioning until after the element is visible so measurements are correct.
    this.requestReposition()
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

    this.currentAnchorEl = null
    if (this.pendingRepositionFrame !== null) {
      window.cancelAnimationFrame(this.pendingRepositionFrame)
      this.pendingRepositionFrame = null
    }
  }

  destroy() {
    this.view.contentDOM.removeEventListener('mouseenter', this.handleEnter, true)
    this.view.contentDOM.removeEventListener('mouseleave', this.handleLeave, true)
    this.view.contentDOM.removeEventListener('mousemove', this.handleMove, true)
    window.removeEventListener('resize', this.handleResize)
  }
}

// =============================================================================
// EXPORT
// =============================================================================

export const hunkHoverPlugin = ViewPlugin.fromClass(HunkHoverManager)
