/**
 * Inline Review CM6 Extension
 *
 * Renders diff decorations directly in the main editor — green/red backgrounds
 * for inserted/deleted text, with per-chunk accept/reject widget buttons.
 *
 * The editor shows the LIVE Yjs doc (base text before proposal). Chunk positions
 * (baseStart/baseEnd) map directly to editor positions.
 *
 * - Deleted text: highlighted with red background + strikethrough
 * - Inserted text: shown as a green block widget below the deletion point
 * - Replace: deleted lines in red, then inserted lines in green widget below
 */

import {
  StateField,
  StateEffect,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  keymap,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { ReviewChunk } from "./types";

// ============================================================================
// TYPES
// ============================================================================

export interface InlineReviewState {
  chunks: ReviewChunk[];
  resolutions: Map<string, "accepted" | "rejected">;
  activeChunkIndex: number; // -1 = none
}

interface InlineReviewCallbacks {
  onAcceptChunk: (chunk: ReviewChunk) => void;
  onRejectChunk: (chunk: ReviewChunk) => void;
}

// ============================================================================
// STATE EFFECTS
// ============================================================================

/** Load chunks for review */
export const setReviewChunks = StateEffect.define<ReviewChunk[]>();

/** Resolve a chunk (accept or reject) */
export const resolveChunk = StateEffect.define<{
  chunkId: string;
  status: "accepted" | "rejected";
}>();

/** Set active chunk index for navigation */
export const setActiveChunk = StateEffect.define<number>();

/** Clear all review state */
export const clearReview = StateEffect.define<void>();

// ============================================================================
// STATE FIELD
// ============================================================================

const emptyState: InlineReviewState = {
  chunks: [],
  resolutions: new Map(),
  activeChunkIndex: -1,
};

export const inlineReviewField = StateField.define<InlineReviewState>({
  create() {
    return emptyState;
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewChunks)) {
        return {
          chunks: effect.value,
          resolutions: new Map(),
          activeChunkIndex: effect.value.length > 0 ? 0 : -1,
        };
      }
      if (effect.is(resolveChunk)) {
        const next = new Map(value.resolutions);
        next.set(effect.value.chunkId, effect.value.status);
        return { ...value, resolutions: next };
      }
      if (effect.is(setActiveChunk)) {
        return { ...value, activeChunkIndex: effect.value };
      }
      if (effect.is(clearReview)) {
        return emptyState;
      }
    }
    return value;
  },
});

// ============================================================================
// WIDGET: Chunk Action Buttons (Accept / Reject)
// ============================================================================

class ChunkActionWidget extends WidgetType {
  constructor(
    private chunk: ReviewChunk,
    private callbacks: InlineReviewCallbacks,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-review-chunk-actions";

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "cm-review-accept-btn";
    acceptBtn.textContent = "\u2713 Accept";
    acceptBtn.title = "Accept chunk (Ctrl-Enter)";
    acceptBtn.type = "button";
    acceptBtn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // prevent editor focus loss
      this.callbacks.onAcceptChunk(this.chunk);
    });

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "cm-review-reject-btn";
    rejectBtn.textContent = "\u2717 Reject";
    rejectBtn.title = "Reject chunk (Ctrl-Backspace)";
    rejectBtn.type = "button";
    rejectBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.callbacks.onRejectChunk(this.chunk);
    });

    wrap.appendChild(acceptBtn);
    wrap.appendChild(rejectBtn);
    return wrap;
  }

  eq(other: ChunkActionWidget): boolean {
    return this.chunk.id === other.chunk.id;
  }

  ignoreEvent(): boolean {
    return false; // allow click events to propagate
  }
}

// ============================================================================
// WIDGET: Inserted Text Block
// ============================================================================

class InsertedTextWidget extends WidgetType {
  constructor(
    private text: string,
    private isActive: boolean,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-review-inserted-block";
    if (this.isActive) {
      wrap.classList.add("cm-review-active-chunk");
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
    return this.text === other.text && this.isActive === other.isActive;
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
// VIEW PLUGIN: Build decorations from state
// ============================================================================

function makeInlineReviewPlugin(callbacks: InlineReviewCallbacks) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        const oldState = update.startState.field(inlineReviewField);
        const newState = update.state.field(inlineReviewField);
        if (oldState !== newState || update.docChanged) {
          this.decorations = this.buildDecorations(update.view);

          // Scroll to active chunk when activeChunkIndex changes
          if (
            oldState.activeChunkIndex !== newState.activeChunkIndex &&
            newState.activeChunkIndex >= 0 &&
            newState.activeChunkIndex < newState.chunks.length
          ) {
            const chunk = newState.chunks[newState.activeChunkIndex]!;
            // Defer scroll to after the current transaction is applied
            requestAnimationFrame(() => {
              scrollToChunk(update.view, chunk);
            });
          }
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const state = view.state.field(inlineReviewField);
        if (state.chunks.length === 0) {
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

        for (let i = 0; i < state.chunks.length; i++) {
          const chunk = state.chunks[i]!;
          const isActive = i === state.activeChunkIndex;

          // Skip resolved chunks — they disappear immediately
          if (state.resolutions.has(chunk.id)) {
            continue;
          }

          const doc = view.state.doc;
          const docLength = doc.length;

          // Clamp positions to document bounds
          const chunkStart = Math.min(chunk.baseStart, docLength);
          const chunkEnd = Math.min(chunk.baseEnd, docLength);

          // Action widget at the start of the chunk
          decos.push({
            from: chunkStart,
            to: chunkStart,
            startSide: -1,
            deco: Decoration.widget({
              widget: new ChunkActionWidget(chunk, callbacks),
              side: -1, // before the content
            }),
          });

          // Deleted text decorations (red background + strikethrough on each line)
          if (chunk.deletedText) {
            const startLine = doc.lineAt(chunkStart);
            const endLine = doc.lineAt(Math.max(chunkStart, chunkEnd - 1));

            for (let line = startLine.number; line <= endLine.number; line++) {
              const lineObj = doc.line(line);
              const cls = isActive
                ? "cm-review-deleted-line cm-review-active-chunk"
                : "cm-review-deleted-line";

              decos.push({
                from: lineObj.from,
                to: lineObj.from,
                startSide: lineStartSide,
                deco: Decoration.line({ class: cls }),
              });
            }
          }

          // Inserted text as a block widget below the deletion point
          if (chunk.insertedText) {
            // For pure inserts (baseStart === baseEnd), show at baseStart.
            // For replaces, show after the deleted region.
            const insertPos = chunkEnd;

            decos.push({
              from: insertPos,
              to: insertPos,
              startSide: 1,
              deco: Decoration.widget({
                widget: new InsertedTextWidget(chunk.insertedText, isActive),
                block: true,
                side: 1, // after the line content
              }),
            });
          }
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
    },
    {
      decorations: (v) => v.decorations,
    },
  );
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
        const pending = getPendingChunks(state);
        if (pending.length === 0) return false;

        const currentIdx = state.activeChunkIndex;
        // Find next pending chunk index
        const nextIdx = findNextPendingIndex(state, currentIdx, 1);
        if (nextIdx !== -1) {
          view.dispatch({ effects: setActiveChunk.of(nextIdx) });
          scrollToChunk(view, state.chunks[nextIdx]!);
        }
        return true;
      },
    },
    {
      key: "Ctrl-[",
      run(view) {
        const state = view.state.field(inlineReviewField);
        const pending = getPendingChunks(state);
        if (pending.length === 0) return false;

        const currentIdx = state.activeChunkIndex;
        const prevIdx = findNextPendingIndex(state, currentIdx, -1);
        if (prevIdx !== -1) {
          view.dispatch({ effects: setActiveChunk.of(prevIdx) });
          scrollToChunk(view, state.chunks[prevIdx]!);
        }
        return true;
      },
    },
    {
      key: "Ctrl-Enter",
      run(view) {
        const state = view.state.field(inlineReviewField);
        if (
          state.activeChunkIndex < 0 ||
          state.activeChunkIndex >= state.chunks.length
        )
          return false;

        const chunk = state.chunks[state.activeChunkIndex]!;
        if (state.resolutions.has(chunk.id)) return false;

        callbacks.onAcceptChunk(chunk);
        return true;
      },
    },
    {
      key: "Ctrl-Backspace",
      run(view) {
        const state = view.state.field(inlineReviewField);
        if (
          state.activeChunkIndex < 0 ||
          state.activeChunkIndex >= state.chunks.length
        )
          return false;

        const chunk = state.chunks[state.activeChunkIndex]!;
        if (state.resolutions.has(chunk.id)) return false;

        callbacks.onRejectChunk(chunk);
        return true;
      },
    },
  ]);
}

// ============================================================================
// HELPERS
// ============================================================================

function getPendingChunks(state: InlineReviewState): ReviewChunk[] {
  return state.chunks.filter((c) => !state.resolutions.has(c.id));
}

/** Find next pending chunk index in a given direction (1 = forward, -1 = backward) */
function findNextPendingIndex(
  state: InlineReviewState,
  currentIdx: number,
  direction: 1 | -1,
): number {
  const len = state.chunks.length;
  if (len === 0) return -1;

  for (let step = 1; step <= len; step++) {
    const idx = ((currentIdx + direction * step) % len + len) % len;
    if (!state.resolutions.has(state.chunks[idx]!.id)) {
      return idx;
    }
  }
  return -1;
}

/** Scroll the editor to make a chunk visible */
function scrollToChunk(view: EditorView, chunk: ReviewChunk): void {
  const pos = Math.min(chunk.baseStart, view.state.doc.length);
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
}

// ============================================================================
// THEME
// ============================================================================

const inlineReviewTheme = EditorView.baseTheme({
  ".cm-review-deleted-line": {
    backgroundColor: "rgba(239, 68, 68, 0.15)", // red-500 at 15%
    textDecoration: "line-through",
    opacity: "0.7",
  },
  ".cm-review-inserted-block": {
    backgroundColor: "rgba(34, 197, 94, 0.15)", // green-500 at 15%
    padding: "2px 0",
    borderLeft: "3px solid rgba(34, 197, 94, 0.6)",
  },
  ".cm-review-inserted-line": {
    padding: "0 4px",
    whiteSpace: "pre-wrap",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
  },
  ".cm-review-active-chunk": {
    outline: "2px solid rgba(59, 130, 246, 0.5)", // blue-500 at 50%
    outlineOffset: "-2px",
  },
  ".cm-review-chunk-actions": {
    display: "inline-flex",
    gap: "4px",
    padding: "2px 4px",
    fontSize: "12px",
  },
  ".cm-review-accept-btn": {
    cursor: "pointer",
    padding: "1px 6px",
    borderRadius: "3px",
    border: "1px solid rgba(34, 197, 94, 0.5)",
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    color: "inherit",
    "&:hover": { backgroundColor: "rgba(34, 197, 94, 0.25)" },
  },
  ".cm-review-reject-btn": {
    cursor: "pointer",
    padding: "1px 6px",
    borderRadius: "3px",
    border: "1px solid rgba(239, 68, 68, 0.5)",
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    color: "inherit",
    "&:hover": { backgroundColor: "rgba(239, 68, 68, 0.25)" },
  },
});

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Create the inline review extension array.
 * Add to editor's extensions when review is active.
 */
export function inlineReviewExtension(callbacks: InlineReviewCallbacks): Extension[] {
  return [
    inlineReviewField,
    makeInlineReviewPlugin(callbacks),
    makeInlineReviewKeymap(callbacks),
    inlineReviewTheme,
  ];
}

/** Load review chunks into the editor */
export function setReviewChunksEffect(
  view: EditorView,
  chunks: ReviewChunk[],
): void {
  view.dispatch({ effects: setReviewChunks.of(chunks) });
}

/** Clear all review state */
export function clearReviewEffect(view: EditorView): void {
  view.dispatch({ effects: clearReview.of(undefined) });
}

/** Resolve a specific chunk */
export function resolveChunkEffect(
  view: EditorView,
  chunkId: string,
  status: "accepted" | "rejected",
): void {
  view.dispatch({ effects: resolveChunk.of({ chunkId, status }) });
}

/** Set the active chunk index for navigation */
export function setActiveChunkIndex(
  view: EditorView,
  index: number,
): void {
  view.dispatch({ effects: setActiveChunk.of(index) });
}

/** Read inline review state from editor state (returns null if field not present) */
export function getInlineReviewState(
  state: EditorState,
): InlineReviewState | null {
  try {
    return state.field(inlineReviewField);
  } catch {
    // Field not in editor — extension not loaded
    return null;
  }
}
