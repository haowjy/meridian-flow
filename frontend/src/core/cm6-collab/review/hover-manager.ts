/**
 * HunkHoverManager — CM6 ViewPlugin for hover/focus visibility of
 * floating review action toolbars (.cm-review-actions).
 *
 * Event delegation on contentDOM (capture phase):
 * - mouseenter [data-hunk-id] -> show toolbar, cancel pending hide
 * - mouseleave -> start 150ms hide delay (prevents flicker on fast mouse movement)
 * - mouseenter on .cm-review-actions -> cancel pending hide (bridge traversal)
 *
 * Positioning: toolbar is right-aligned to the anchor line area, defaulting
 * above the hunk. Flips below when near top of viewport. This avoids
 * jittery mouse-following and matches VS Code's gutter action pattern.
 *
 * Click outside any [data-hunk-id] region clears the focused state via
 * setActiveHunk.of(-1).
 *
 * This plugin is the SINGLE SOURCE OF TRUTH for toolbar visibility (#3).
 * It manages both hover-triggered and focus-triggered (keyboard nav)
 * toolbars so that only one toolbar is visible at a time.
 */

import { ViewPlugin, type ViewUpdate, EditorView } from "@codemirror/view";
import { inlineReviewField, setActiveHunk } from "./state";

/** Delay before hiding toolbar on mouseleave (ms). Combined with the
 *  16px CSS bridge (::after on .cm-review-actions), this prevents
 *  flickering when moving between text and toolbar. */
const HIDE_DELAY_MS = 150;

class HunkHoverManager {
  private currentHunkId: string | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingRepositionFrame: number | null = null;

  // Bound handlers for cleanup
  private handleMouseEnter: (e: Event) => void;
  private handleMouseLeave: (e: Event) => void;
  private handleMouseDown: (e: MouseEvent) => void;

  constructor(private view: EditorView) {
    this.handleMouseEnter = this.onMouseEnter.bind(this);
    this.handleMouseLeave = this.onMouseLeave.bind(this);
    this.handleMouseDown = this.onMouseDown.bind(this);

    // Capture phase for event delegation — intercepts before bubbling
    this.view.contentDOM.addEventListener("mouseenter", this.handleMouseEnter, true);
    this.view.contentDOM.addEventListener("mouseleave", this.handleMouseLeave, true);
    // mousedown on document to detect clicks outside hunk regions
    this.view.contentDOM.addEventListener("mousedown", this.handleMouseDown);
  }

  update(update: ViewUpdate) {
    // Clear hover on doc change (accept/reject removes hunk)
    if (update.docChanged && this.currentHunkId) {
      this.hideActions(this.currentHunkId);
      this.removeHoverPreview(this.currentHunkId);
      this.currentHunkId = null;
    }
    // Reposition on geometry/viewport changes
    if ((update.geometryChanged || update.viewportChanged) && this.currentHunkId) {
      this.requestReposition();
    }

    // (#3) When activeHunkIndex changes via keyboard, ensure focused toolbar
    // is positioned and that any stale hover toolbar is hidden.
    const oldState = update.startState.field(inlineReviewField, false);
    const newState = update.state.field(inlineReviewField, false);
    if (oldState && newState && oldState.activeHunkIndex !== newState.activeHunkIndex) {
      // Hide any current hover toolbar that doesn't match the new focus
      if (this.currentHunkId) {
        const focusedHunk = newState.activeHunkIndex >= 0 && newState.activeHunkIndex < newState.hunks.length
          ? newState.hunks[newState.activeHunkIndex]!
          : null;
        if (!focusedHunk || focusedHunk.id !== this.currentHunkId) {
          this.hideActions(this.currentHunkId);
          this.removeHoverPreview(this.currentHunkId);
          this.currentHunkId = null;
        }
      }

      // Position the focused-visible toolbar if one exists
      if (newState.activeHunkIndex >= 0 && newState.activeHunkIndex < newState.hunks.length) {
        const hunk = newState.hunks[newState.activeHunkIndex]!;
        // Defer to next frame so the DOM has updated with the new focused-visible class
        requestAnimationFrame(() => {
          const actionsEl = this.findActionsForHunk(hunk.id);
          if (actionsEl?.classList.contains("cm-review-focused-visible")) {
            this.positionToolbar(actionsEl, hunk.id);
          }
        });
      }
    }
  }

  destroy() {
    this.view.contentDOM.removeEventListener("mouseenter", this.handleMouseEnter, true);
    this.view.contentDOM.removeEventListener("mouseleave", this.handleMouseLeave, true);
    this.view.contentDOM.removeEventListener("mousedown", this.handleMouseDown);
    if (this.hideTimeout) clearTimeout(this.hideTimeout);
    if (this.pendingRepositionFrame) cancelAnimationFrame(this.pendingRepositionFrame);
  }

  // === Event handlers ===

  private onMouseEnter(e: Event) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Mouse entered the toolbar itself — cancel pending hide (bridge traversal)
    const actionsEl = target.closest?.(".cm-review-actions");
    if (actionsEl) {
      this.cancelHide();
      return;
    }

    // Mouse entered a hunk-marked element
    const hunkEl = target.closest?.("[data-hunk-id]");
    if (hunkEl) {
      const hunkId = (hunkEl as HTMLElement).dataset.hunkId;
      if (!hunkId) return;

      this.cancelHide();

      // If switching to a different hunk, hide the old one first
      if (this.currentHunkId && this.currentHunkId !== hunkId) {
        this.hideActions(this.currentHunkId);
        this.removeHoverPreview(this.currentHunkId);
      }

      // (#3) Hide any focused-visible toolbar that isn't this hunk
      this.hideFocusedToolbarIfDifferent(hunkId);

      this.currentHunkId = hunkId;
      this.showActions(hunkId);
      this.applyHoverPreview(hunkId);
    }
  }

  private onMouseLeave(e: Event) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Leaving a hunk region or toolbar — start delayed hide
    const hunkEl = target.closest?.("[data-hunk-id]");
    const actionsEl = target.closest?.(".cm-review-actions");
    if (hunkEl || actionsEl) {
      this.startDelayedHide();
    }
  }

  private onMouseDown(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Click inside a hunk region or toolbar — do nothing
    const hunkEl = target.closest?.("[data-hunk-id]");
    const actionsEl = target.closest?.(".cm-review-actions");
    if (hunkEl || actionsEl) return;

    // Click outside any hunk region — clear focused state
    const state = this.view.state.field(inlineReviewField, false);
    if (state && state.activeHunkIndex >= 0) {
      this.view.dispatch({ effects: setActiveHunk.of(-1) });
    }
  }

  // === Visibility control ===

  private showActions(hunkId: string) {
    const actionsEl = this.findActionsForHunk(hunkId);
    if (!actionsEl) return;

    actionsEl.classList.add("visible");
    this.positionToolbar(actionsEl, hunkId);
  }

  private hideActions(hunkId: string) {
    const actionsEl = this.findActionsForHunk(hunkId);
    if (!actionsEl) return;

    actionsEl.classList.remove("visible");
  }

  /**
   * (#3) Hide any focused-visible toolbar that belongs to a different hunk.
   * Ensures only one toolbar is visible at a time when hovering a different
   * hunk while a focused hunk has a visible toolbar.
   */
  private hideFocusedToolbarIfDifferent(hunkId: string) {
    const focusedEls = this.view.scrollDOM.querySelectorAll(
      ".cm-review-actions.cm-review-focused-visible",
    );
    for (const el of focusedEls) {
      if ((el as HTMLElement).dataset.hunkId !== hunkId) {
        (el as HTMLElement).classList.remove("cm-review-focused-visible");
      }
    }
  }

  // === Hover preview (#1) ===
  // CSS descendant/sibling selectors can't reach across CM6's DOM structure
  // (mark spans inside line divs, inserted blocks as siblings of line divs).
  // Instead we toggle .cm-review-hovered on the relevant DOM elements directly.

  private applyHoverPreview(hunkId: string) {
    const escapedId = CSS.escape(hunkId);

    // Deleted lines: find mark spans with this hunk ID, walk up to their
    // parent .cm-line, and add .cm-review-hovered to the line
    const markEls = this.view.contentDOM.querySelectorAll(
      `[data-hunk-id="${escapedId}"].cm-review-deleted-mark`,
    );
    for (const el of markEls) {
      const lineEl = (el as HTMLElement).closest(".cm-line");
      if (lineEl) lineEl.classList.add("cm-review-hovered");
    }

    // Inserted block: add .cm-review-hovered directly
    const insertedBlocks = this.view.scrollDOM.querySelectorAll(
      `.cm-review-inserted-block[data-hunk-id="${escapedId}"]`,
    );
    for (const el of insertedBlocks) {
      (el as HTMLElement).classList.add("cm-review-hovered");
    }
  }

  private removeHoverPreview(hunkId: string) {
    const escapedId = CSS.escape(hunkId);

    // Remove from deleted lines
    const markEls = this.view.contentDOM.querySelectorAll(
      `[data-hunk-id="${escapedId}"].cm-review-deleted-mark`,
    );
    for (const el of markEls) {
      const lineEl = (el as HTMLElement).closest(".cm-line");
      if (lineEl) lineEl.classList.remove("cm-review-hovered");
    }

    // Remove from inserted blocks
    const insertedBlocks = this.view.scrollDOM.querySelectorAll(
      `.cm-review-inserted-block[data-hunk-id="${escapedId}"]`,
    );
    for (const el of insertedBlocks) {
      (el as HTMLElement).classList.remove("cm-review-hovered");
    }
  }

  private startDelayedHide() {
    this.cancelHide();
    this.hideTimeout = setTimeout(() => {
      if (this.currentHunkId) {
        this.hideActions(this.currentHunkId);
        this.removeHoverPreview(this.currentHunkId);
        this.currentHunkId = null;
      }
    }, HIDE_DELAY_MS);
  }

  private cancelHide() {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  // === Positioning ===

  private requestReposition() {
    if (this.pendingRepositionFrame) cancelAnimationFrame(this.pendingRepositionFrame);
    this.pendingRepositionFrame = requestAnimationFrame(() => {
      this.pendingRepositionFrame = null;
      if (this.currentHunkId) {
        const actionsEl = this.findActionsForHunk(this.currentHunkId);
        if (actionsEl?.classList.contains("visible")) {
          this.positionToolbar(actionsEl, this.currentHunkId);
        }
      }
    });
  }

  /**
   * Position the toolbar right-aligned to the hunk's anchor line area.
   * Default position is above the hunk; flips below when near top of viewport.
   * Adds/removes .flipped class so the CSS bridge (::after) extends in the
   * correct direction (#9).
   */
  private positionToolbar(actionsEl: HTMLElement, hunkId: string) {
    // Find the anchor element — the first element with this hunk ID in the editor
    const anchorEl = this.view.contentDOM.querySelector(
      `[data-hunk-id="${CSS.escape(hunkId)}"]`,
    ) as HTMLElement | null;
    if (!anchorEl) return;

    const scrollDOM = this.view.scrollDOM;
    const scrollerRect = scrollDOM.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const toolbarHeight = actionsEl.offsetHeight || 28; // fallback estimate

    // Vertical positioning: above by default, flip below near top of viewport
    const flipBelow = anchorRect.top - toolbarHeight - 4 < scrollerRect.top;

    if (flipBelow) {
      // Position below the anchor
      actionsEl.style.top = `${anchorRect.bottom - scrollerRect.top + scrollDOM.scrollTop + 4}px`;
      actionsEl.classList.add("flipped");
    } else {
      // Position above the anchor
      actionsEl.style.top = `${anchorRect.top - scrollerRect.top + scrollDOM.scrollTop - toolbarHeight - 4}px`;
      actionsEl.classList.remove("flipped");
    }

    // Horizontal: right-aligned relative to content area
    const contentRect = this.view.contentDOM.getBoundingClientRect();
    actionsEl.style.right = `${scrollerRect.right - contentRect.right}px`;
    // Ensure we don't go off the left edge
    actionsEl.style.left = "auto";

    // Remove the CSS transform since we're positioning explicitly
    actionsEl.style.transform = "none";
    actionsEl.style.marginTop = "0";
  }

  // === Helpers ===

  private findActionsForHunk(hunkId: string): HTMLElement | null {
    // Search within the editor's scroll DOM for the action widget
    return this.view.scrollDOM.querySelector(
      `.cm-review-actions[data-hunk-id="${CSS.escape(hunkId)}"]`,
    ) as HTMLElement | null;
  }
}

export const hunkHoverPlugin = ViewPlugin.fromClass(HunkHoverManager);
