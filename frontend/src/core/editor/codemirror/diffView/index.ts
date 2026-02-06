/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 * - Blocks edits in deletion regions
 * - Accept/reject as CM6 transactions (undoable!)
 * - Focused hunk highlighting and navigation
 *
 * Entry point for diff view functionality.
 */

import { type Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diffViewPlugin } from "./plugin";
import { diffEditFilter } from "./editFilter";
import {
  createBlockedEditListener,
  type BlockedEditCallback,
} from "./blockedEditListener";
import { clipboardExtension } from "./clipboard";
import { focusedHunkIndexField } from "./focus";
import { hunkHoverPlugin } from "./hoverManager";
import { hunkRegionsField } from "./hunkRegionsField";

// =============================================================================
// RE-EXPORTS
// =============================================================================

export { diffViewPlugin } from "./plugin";
export { diffEditFilter } from "./editFilter";
export { blockedEditEffect, type BlockedEditReason } from "./blockedEditEffect";
export {
  createBlockedEditListener,
  type BlockedEditCallback,
} from "./blockedEditListener";
export { clipboardExtension } from "./clipboard";

// Transactions (accept/reject)
export {
  acceptHunk,
  rejectHunk,
  acceptHunkAtPosition,
  rejectHunkAtPosition,
  acceptAll,
  rejectAll,
  getHunks,
} from "./transactions";

// Focus state
export { setFocusedHunkIndexEffect, focusedHunkIndexField } from "./focus";

// Widget (for advanced use cases)
export { HunkActionWidget } from "./HunkActionWidget";

// Hover manager (JS-based hover for multiple hunks per line)
export { hunkHoverPlugin } from "./hoverManager";

// Hunk regions (for live preview integration)
export {
  hunkRegionsField,
  overlapsHunkRegion,
  type HunkRegion,
} from "./hunkRegionsField";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Callback for when document content changes via accept/reject.
 * Used to sync React state with CM6 editor state.
 */
export type ContentChangedCallback = (content: string) => void;

/**
 * Callback for when hunk focus changes (click inside or outside hunk).
 * @param hunkIndex - Index of clicked hunk, or -1 if clicked outside all hunks
 */
export type HunkFocusChangeCallback = (hunkIndex: number) => void;

/**
 * Options for the diff view extension bundle.
 */
export interface DiffViewExtensionOptions {
  /** Called when an edit is blocked (for showing toast) */
  onBlockedEdit?: BlockedEditCallback;
  /**
   * Called when document changes via accept/reject transaction.
   * Use this to sync React state (localDocument, hasUserEdit) with editor.
   */
  onContentChanged?: ContentChangedCallback;
  /**
   * Called when hunk focus changes (user clicks inside or outside hunks).
   * Pass hunkIndex (0+) when clicking inside a hunk, or -1 when clicking outside.
   */
  onHunkFocusChange?: HunkFocusChangeCallback;
}

// =============================================================================
// LISTENERS
// =============================================================================

/**
 * Create an updateListener that detects accept/reject transactions
 * and calls the callback with the new document content.
 *
 * This ensures React state (localDocument, hasUserEdit) stays in sync
 * with CM6 editor state when users accept/reject hunks.
 */
function createContentChangedListener(
  callback: ContentChangedCallback,
): Extension {
  return EditorView.updateListener.of((update) => {
    // Check if any transaction is an accept/reject operation
    const hasAcceptReject = update.transactions.some((tr) => {
      const event = tr.annotation(Transaction.userEvent);
      return event?.startsWith("ai.diff.");
    });

    // If accept/reject changed the document, notify React
    if (hasAcceptReject && update.docChanged) {
      callback(update.state.doc.toString());
    }
  });
}

/**
 * Create an updateListener that detects clicks inside or outside hunks
 * and calls the callback with the appropriate hunk index.
 *
 * SRP: Single callback handles both focus (click inside) and unfocus (click outside).
 */
function createHunkFocusChangeListener(
  callback: HunkFocusChangeCallback,
): Extension {
  return EditorView.updateListener.of((update) => {
    // Only process selection changes (user clicked somewhere)
    if (!update.selectionSet) return;

    const cursorPos = update.state.selection.main.head;
    const regions = update.state.field(hunkRegionsField, false);

    // If no regions (no hunks), nothing to do
    if (!regions || regions.length === 0) return;

    // Find which hunk contains the cursor, or -1 if outside all hunks
    // Use exclusive end [from, to) to prevent boundary ambiguity between adjacent hunks
    const clickedHunkIndex = regions.findIndex(
      (region) => cursorPos >= region.from && cursorPos < region.to,
    );

    // Notify callback: hunk index (0+) if inside, or -1 if outside
    callback(clickedHunkIndex);
  });
}

// =============================================================================
// EXTENSION BUNDLE
// =============================================================================

/**
 * Create the diff view extension bundle.
 *
 * OCP: Accepts options for extensibility.
 *
 * @param options - Optional configuration
 * @returns Extension array with view plugin, edit filter, and optional listener
 *
 * @example
 * ```typescript
 * // In EditorPanel, wrap in a Compartment for dynamic reconfiguration
 * const diffCompartment = new Compartment()
 *
 * // Initial: empty
 * extensions: [diffCompartment.of([])]
 *
 * // Enable diff view with feedback:
 * view.dispatch({
 *   effects: diffCompartment.reconfigure(createDiffViewExtension({
 *     onBlockedEdit: (reason) => console.log('Cannot edit here:', reason)
 *   }))
 * })
 * ```
 */
export function createDiffViewExtension(
  options?: DiffViewExtensionOptions,
): Extension {
  const extensions: Extension[] = [
    hunkRegionsField, // Must be first - live preview reads this field
    focusedHunkIndexField, // Must be before diffViewPlugin (plugin reads this field)
    diffViewPlugin,
    diffEditFilter,
    clipboardExtension,
    hunkHoverPlugin, // JS-based hover visibility for action buttons
  ];

  if (options?.onBlockedEdit) {
    extensions.push(createBlockedEditListener(options.onBlockedEdit));
  }

  if (options?.onContentChanged) {
    extensions.push(createContentChangedListener(options.onContentChanged));
  }

  if (options?.onHunkFocusChange) {
    extensions.push(createHunkFocusChangeListener(options.onHunkFocusChange));
  }

  return extensions;
}
