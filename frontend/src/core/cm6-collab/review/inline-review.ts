/**
 * Inline Review CM6 Extension
 *
 * Renders diff decorations directly in the main editor — green/red backgrounds
 * for inserted/deleted text, with a floating hover toolbar for per-hunk
 * keep/discard actions.
 *
 * The editor shows the LIVE Yjs doc (base text before proposal). Hunk positions
 * (baseStart/baseEnd) map directly to editor positions.
 *
 * - Deleted text: highlighted with red background + strikethrough (line deco)
 *   + mark deco with data-hunk-id for hover identity
 * - Inserted text: shown as a green block widget below the deletion point
 * - Replace: deleted lines in red, then inserted lines in green widget below
 * - Action buttons: floating toolbar (hidden by default, shown on hover/focus)
 */

import {
  StateField,
  type EditorState,
  type Extension,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  WidgetType,
  type DecorationSet,
  EditorView,
  keymap,
} from "@codemirror/view";
import type { ReviewHunk } from "./types";
import { hunkHoverPlugin } from "./hover-manager";
import {
  inlineReviewField,
  setReviewHunks,
  resolveHunk,
  setActiveHunk,
  clearReview,
  type InlineReviewState,
  type InlineReviewCallbacks,
} from "./state";

// Re-export shared state for consumers
export {
  inlineReviewField,
  setReviewHunks,
  resolveHunk,
  setActiveHunk,
  clearReview,
  type InlineReviewState,
  type InlineReviewCallbacks,
} from "./state";

// ============================================================================
// WIDGET: Hunk Action Buttons (Keep / Discard) — Floating Toolbar
// ============================================================================
// Replaces the old ChunkActionWidget that rendered inline at chunkStart and
// caused stacking in document flow. This widget is absolutely positioned and
// hidden by default — shown on hover via HunkHoverManager or on focus via
// keyboard navigation (.cm-review-focused-visible class).
//
// Uses onclick (not mousedown) because ignoreEvent() returns true, which
// prevents CM6 from processing events on the widget. This avoids the need
// for preventDefault() to prevent editor focus loss.

class HunkActionWidget extends WidgetType {
  constructor(
    private hunk: ReviewHunk,
    private callbacks: InlineReviewCallbacks,
    private isFocused: boolean,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("span");
    // Focused class for auto-visibility (keyboard nav / mobile)
    container.className = this.isFocused
      ? "cm-review-actions cm-review-focused-visible"
      : "cm-review-actions";
    container.dataset.hunkId = this.hunk.id;

    // Writer-first language: "Keep" / "Discard" instead of "Accept" / "Reject"
    const keepBtn = document.createElement("button");
    keepBtn.textContent = "Keep \u2713";
    keepBtn.className = "cm-review-accept-btn";
    keepBtn.title = "Keep this change (Ctrl-Enter)";
    keepBtn.type = "button";
    keepBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.callbacks.onAcceptHunk(this.hunk);
    };

    const discardBtn = document.createElement("button");
    discardBtn.textContent = "Discard \u2717";
    discardBtn.className = "cm-review-reject-btn";
    discardBtn.title = "Discard this change (Ctrl-Backspace)";
    discardBtn.type = "button";
    discardBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.callbacks.onRejectHunk(this.hunk);
    };

    container.appendChild(keepBtn);
    container.appendChild(discardBtn);
    return container;
  }

  eq(other: HunkActionWidget): boolean {
    return this.hunk.id === other.hunk.id && this.isFocused === other.isFocused;
  }

  ignoreEvent(): boolean {
    return true; // CM6 must not hijack widget interactions
  }
}

// ============================================================================
// WIDGET: Inserted Text Block
// ============================================================================

class InsertedTextWidget extends WidgetType {
  constructor(
    private text: string,
    private isActive: boolean,
    private chunkId: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-review-inserted-block";
    // data-hunk-id for hover identity — HunkHoverManager uses this to
    // know which hunk the mouse is over
    wrap.dataset.hunkId = this.chunkId;
    if (this.isActive) {
      wrap.classList.add("cm-review-active-hunk");
    }

    // Render each line of inserted text
    const lines = this.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineEl = document.createElement("div");
      lineEl.className = "cm-review-inserted-line";
      // Preserve whitespace; show empty lines as a single space for visibility
      lineEl.textContent = lines[i] || " ";
      wrap.appendChild(lineEl);
    }

    return wrap;
  }

  eq(other: InsertedTextWidget): boolean {
    return (
      this.text === other.text &&
      this.isActive === other.isActive &&
      this.chunkId === other.chunkId
    );
  }

  ignoreEvent(): boolean {
    return true;
  }

  get estimatedHeight(): number {
    // ~20px per line
    return this.text.split("\n").length * 20;
  }
}

// ============================================================================
// DECORATION STATE FIELD
// ============================================================================
// Block widgets (block: true) MUST be provided via a StateField, not a
// ViewPlugin — CM6 forbids block-level decorations from ViewPlugins.
// This follows the same pattern as inlineElementsField in inlineElements.ts.

/**
 * Build decorations from the current inline review state.
 * Pure function — no side effects, no view dependency.
 *
 * Decoration strategy:
 * - Decoration.line for deleted line visual styling (red bg + strikethrough)
 * - Decoration.mark over deleted ranges for hover identity (data-hunk-id)
 * - InsertedTextWidget block widget with data-hunk-id
 * - HunkActionWidget at hunk end, floating, hidden by default
 */
function buildInlineReviewDecorations(
  state: EditorState,
  reviewState: InlineReviewState,
  callbacks: InlineReviewCallbacks,
): DecorationSet {
  if (reviewState.hunks.length === 0) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();

  // RangeSetBuilder requires ranges sorted by (from, startSide).
  // Track startSide explicitly so same-position decorations are ordered safely.
  const decos: {
    from: number;
    to: number;
    startSide: number;
    deco: Decoration;
  }[] = [];
  const lineStartSide = Decoration.line({ class: "" }).startSide;

  for (let i = 0; i < reviewState.hunks.length; i++) {
    const hunk = reviewState.hunks[i]!;
    const isActive = i === reviewState.activeHunkIndex;

    // Skip resolved hunks — they disappear immediately
    if (reviewState.resolutions.has(hunk.id)) {
      continue;
    }

    const doc = state.doc;
    const docLength = doc.length;

    // Clamp positions to document bounds
    const hunkStart = Math.min(hunk.baseStart, docLength);
    const hunkEnd = Math.min(hunk.baseEnd, docLength);

    // Deleted text decorations (#4: check !== undefined, not falsy —
    // empty string "" is valid data per project rules)
    if (hunk.deletedText !== undefined) {
      const startLine = doc.lineAt(hunkStart);
      const endLine = doc.lineAt(Math.max(hunkStart, hunkEnd - 1));

      // Line decorations for visual styling (red bg + strikethrough per line)
      for (let line = startLine.number; line <= endLine.number; line++) {
        const lineObj = doc.line(line);
        const cls = isActive
          ? "cm-review-deleted-line cm-review-active-hunk"
          : "cm-review-deleted-line";

        decos.push({
          from: lineObj.from,
          to: lineObj.from,
          startSide: lineStartSide,
          deco: Decoration.line({ class: cls }),
        });
      }

      // Mark decoration over deleted text range for hover identity (data-hunk-id).
      // Mark decorations are per-range so multiple hunks on the same line each
      // get their own attribute — unlike line decorations which are ambiguous.
      if (hunkStart < hunkEnd) {
        const markDeco = Decoration.mark({
          class: "cm-review-deleted-mark",
          attributes: { "data-hunk-id": hunk.id },
        });
        decos.push({
          from: hunkStart,
          to: hunkEnd,
          startSide: markDeco.startSide,
          deco: markDeco,
        });
      }
    }

    // Inserted text as a block widget below the deletion point
    // (#4: check !== undefined, not falsy — empty string "" is valid data)
    if (hunk.insertedText !== undefined) {
      // For pure inserts (baseStart === baseEnd), show at baseStart.
      // For replaces, show after the deleted region.
      const insertPos = hunkEnd;

      decos.push({
        from: insertPos,
        to: insertPos,
        startSide: 1,
        deco: Decoration.widget({
          widget: new InsertedTextWidget(hunk.insertedText, isActive, hunk.id),
          block: true,
          side: 1, // after the line content
        }),
      });
    }

    // Floating action widget at the END of the hunk (not start).
    // Hidden by default, shown on hover via HunkHoverManager or on focus
    // via keyboard navigation (.cm-review-focused-visible class).
    decos.push({
      from: hunkEnd,
      to: hunkEnd,
      startSide: 1,
      deco: Decoration.widget({
        widget: new HunkActionWidget(hunk, callbacks, isActive),
        side: 1,
      }),
    });
  }

  // Sort by (from, startSide) to satisfy RangeSetBuilder ordering constraints.
  decos.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.startSide !== b.startSide) return a.startSide - b.startSide;
    return a.to - b.to;
  });

  for (const { from, to, deco } of decos) {
    builder.add(from, to, deco);
  }

  return builder.finish();
}

/**
 * Create the decoration StateField. Needs callbacks in closure so the
 * HunkActionWidget buttons can fire accept/reject handlers.
 */
function makeInlineReviewDecorationField(callbacks: InlineReviewCallbacks) {
  return StateField.define<DecorationSet>({
    create(state) {
      const reviewState = state.field(inlineReviewField);
      return buildInlineReviewDecorations(state, reviewState, callbacks);
    },

    update(decos, tr) {
      const oldReview = tr.startState.field(inlineReviewField);
      const newReview = tr.state.field(inlineReviewField);
      if (oldReview !== newReview || tr.docChanged) {
        return buildInlineReviewDecorations(tr.state, newReview, callbacks);
      }
      return decos;
    },

    provide: (f) => EditorView.decorations.from(f),
  });
}

// ============================================================================
// EDITOR ATTRIBUTES: Conditionally apply .cm-review-active
// ============================================================================
// CSS uses .cm-editor.cm-review-active for positioning context (relative
// scroller + bottom padding). Applied via EditorView.editorAttributes when
// review chunks are present.

const reviewActiveAttrs = EditorView.editorAttributes.compute(
  [inlineReviewField],
  (state): Record<string, string> => {
    const review = state.field(inlineReviewField, false);
    if (review && review.hunks.length > 0) {
      return { class: "cm-review-active" };
    }
    return {};
  },
);

// ============================================================================
// SCROLL LISTENER: Scroll to active hunk on navigation
// ============================================================================
// EditorView.updateListener is appropriate for side effects like scrolling.
// This is the SINGLE scrolling mechanism — keymap handlers rely on this
// listener to scroll after dispatching setActiveHunk (#6: no double scroll).

function makeScrollOnActiveHunkListener() {
  return EditorView.updateListener.of((update) => {
    const oldState = update.startState.field(inlineReviewField);
    const newState = update.state.field(inlineReviewField);
    if (
      oldState.activeHunkIndex !== newState.activeHunkIndex &&
      newState.activeHunkIndex >= 0 &&
      newState.activeHunkIndex < newState.hunks.length
    ) {
      const hunk = newState.hunks[newState.activeHunkIndex]!;
      // Defer scroll to after the current transaction is applied
      requestAnimationFrame(() => {
        scrollToHunk(update.view, hunk);
      });
    }
  });
}

// ============================================================================
// KEYMAPS
// ============================================================================

function makeInlineReviewKeymap(callbacks: InlineReviewCallbacks) {
  return keymap.of([
    {
      key: "Ctrl-]",
      run(view) {
        const state = view.state.field(inlineReviewField);
        const pending = getPendingHunks(state);
        if (pending.length === 0) return false;

        const currentIdx = state.activeHunkIndex;
        const nextIdx = findNextPendingIndex(state, currentIdx, 1);
        if (nextIdx !== -1) {
          // Only dispatch the effect — scrollOnActiveHunkListener handles
          // scrolling (#6: single scroll mechanism)
          view.dispatch({ effects: setActiveHunk.of(nextIdx) });
        }
        return true;
      },
    },
    {
      key: "Ctrl-[",
      run(view) {
        const state = view.state.field(inlineReviewField);
        const pending = getPendingHunks(state);
        if (pending.length === 0) return false;

        const currentIdx = state.activeHunkIndex;
        const prevIdx = findNextPendingIndex(state, currentIdx, -1);
        if (prevIdx !== -1) {
          // Only dispatch the effect — scrollOnActiveHunkListener handles
          // scrolling (#6: single scroll mechanism)
          view.dispatch({ effects: setActiveHunk.of(prevIdx) });
        }
        return true;
      },
    },
    {
      key: "Ctrl-Enter",
      run(view) {
        const state = view.state.field(inlineReviewField);
        if (
          state.activeHunkIndex < 0 ||
          state.activeHunkIndex >= state.hunks.length
        )
          return false;

        const hunk = state.hunks[state.activeHunkIndex]!;
        if (state.resolutions.has(hunk.id)) return false;

        callbacks.onAcceptHunk(hunk);
        return true;
      },
    },
    {
      key: "Ctrl-Backspace",
      run(view) {
        const state = view.state.field(inlineReviewField);
        if (
          state.activeHunkIndex < 0 ||
          state.activeHunkIndex >= state.hunks.length
        )
          return false;

        const hunk = state.hunks[state.activeHunkIndex]!;
        if (state.resolutions.has(hunk.id)) return false;

        callbacks.onRejectHunk(hunk);
        return true;
      },
    },
    {
      // Escape clears focused state — returns to Idle (toolbar hidden)
      key: "Escape",
      run(view) {
        const state = view.state.field(inlineReviewField);
        if (state.activeHunkIndex >= 0) {
          view.dispatch({ effects: setActiveHunk.of(-1) });
          return true;
        }
        return false;
      },
    },
  ]);
}

// ============================================================================
// HELPERS
// ============================================================================

function getPendingHunks(state: InlineReviewState): ReviewHunk[] {
  return state.hunks.filter((c) => !state.resolutions.has(c.id));
}

/** Find next pending hunk index in a given direction (1 = forward, -1 = backward) */
function findNextPendingIndex(
  state: InlineReviewState,
  currentIdx: number,
  direction: 1 | -1,
): number {
  const len = state.hunks.length;
  if (len === 0) return -1;

  for (let step = 1; step <= len; step++) {
    const idx = ((currentIdx + direction * step) % len + len) % len;
    if (!state.resolutions.has(state.hunks[idx]!.id)) {
      return idx;
    }
  }
  return -1;
}

/** Scroll the editor to make a hunk visible */
function scrollToHunk(view: EditorView, hunk: ReviewHunk): void {
  const pos = Math.min(hunk.baseStart, view.state.doc.length);
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Create the inline review extension array.
 * Add to editor's extensions when review is active.
 *
 * Styles are in globals.css (.cm-review-* classes), not baseTheme —
 * for consistency with meridian's approach, easier pseudo-element styling
 * (the ::after bridge), and @media query ergonomics.
 */
export function inlineReviewExtension(callbacks: InlineReviewCallbacks): Extension[] {
  return [
    inlineReviewField,
    reviewActiveAttrs,
    makeInlineReviewDecorationField(callbacks),
    hunkHoverPlugin,
    makeScrollOnActiveHunkListener(),
    makeInlineReviewKeymap(callbacks),
  ];
}

/** Load review hunks into the editor */
export function setReviewHunksEffect(
  view: EditorView,
  hunks: ReviewHunk[],
): void {
  view.dispatch({ effects: setReviewHunks.of(hunks) });
}

/** Clear all review state */
export function clearReviewEffect(view: EditorView): void {
  view.dispatch({ effects: clearReview.of(undefined) });
}

/** Resolve a specific hunk */
export function resolveHunkEffect(
  view: EditorView,
  hunkId: string,
  status: "accepted" | "rejected",
): void {
  view.dispatch({ effects: resolveHunk.of({ hunkId, status }) });
}

/** Set the active hunk index for navigation */
export function setActiveHunkIndex(
  view: EditorView,
  index: number,
): void {
  view.dispatch({ effects: setActiveHunk.of(index) });
}

/** Read inline review state from editor state (returns null if field not present) */
export function getInlineReviewState(
  state: EditorState,
): InlineReviewState | null {
  // #7: Use the optional second param instead of try/catch — returns
  // undefined when the field is absent (extension not loaded)
  return state.field(inlineReviewField, false) ?? null;
}
