/**
 * Inline Elements StateField
 *
 * Manages inline element decorations (references, future: images) in the composer.
 * Each element occupies a single Object Replacement Character (\uFFFC) in the document.
 * A StateField<DecorationSet> tracks Decoration.replace widgets with metadata in spec.
 *
 * Position tracking is automatic via DecorationSet.map(tr.changes).
 * When \uFFFC is deleted (backspace/delete/selection), the decoration's range collapses
 * and is cleaned up automatically.
 */

import {
  StateField,
  StateEffect,
  type EditorState,
  type Range,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { ElementWidget } from "./elementWidget";

// =============================================================================
// TYPES
// =============================================================================

/** Extensible union — add new inline types here */
export type InlineElementType = "reference" | "image";

export interface ReferenceElementData {
  type: "reference";
  documentId: string;
  refType: string; // "document" (future: "image", "s3_document")
  displayName: string;
  documentPath?: string; // for tooltip
}

export interface ImageElementData {
  type: "image";
  tempFileId: string;
  filename: string;
  previewUrl?: string;
}

export type InlineElementData = ReferenceElementData | ImageElementData;

// =============================================================================
// CONSTANTS
// =============================================================================

/** Object Replacement Character — single char placeholder for inline elements */
export const ORC = "\uFFFC";

function shouldAppendTrailingSpace(
  doc: EditorState["doc"],
  insertionEnd: number,
): boolean {
  if (insertionEnd >= doc.length) return true;
  const nextChar = doc.sliceString(insertionEnd, insertionEnd + 1);
  return !/\s/.test(nextChar);
}

// =============================================================================
// EFFECTS
// =============================================================================

/** Effect to add an inline element at a position (the \uFFFC must already be in the doc) */
export const addInlineElement = StateEffect.define<{
  from: number;
  to: number;
  data: InlineElementData;
}>();

/** Effect to remove an inline element by position */
export const removeInlineElement = StateEffect.define<{
  from: number;
  to: number;
}>();

// =============================================================================
// STATE FIELD
// =============================================================================

/**
 * StateField stores DecorationSet — position tracking is automatic via .map(tr.changes).
 * Each Decoration.replace carries metadata in spec.data.
 *
 * Decorations are provided directly to the editor via the `provide` option,
 * so no separate ViewPlugin is needed.
 */
export const inlineElementsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(decos, tr) {
    // Auto-map positions through document changes (handles insertions, deletions, etc.)
    decos = decos.map(tr.changes);

    // Clean up any decorations whose \uFFFC was deleted —
    // if the range collapsed to zero width or the char at that pos is no longer \uFFFC
    const doc = tr.state.doc;
    const toRemove: { from: number; to: number }[] = [];
    const cursor = decos.iter();
    while (cursor.value) {
      const { from, to } = cursor;
      // If the range collapsed (from === to) or the char was deleted/replaced
      if (
        from >= to ||
        from >= doc.length ||
        doc.sliceString(from, to) !== ORC
      ) {
        toRemove.push({ from, to });
      }
      cursor.next();
    }
    if (toRemove.length > 0) {
      decos = decos.update({
        filter: (from, to) =>
          !toRemove.some((r) => r.from === from && r.to === to),
      });
    }

    // Process effects
    for (const e of tr.effects) {
      if (e.is(addInlineElement)) {
        const widget = new ElementWidget(e.value.data);
        const deco = Decoration.replace({
          widget,
          inclusive: false,
          data: e.value.data,
        });
        decos = decos.update({
          add: [deco.range(e.value.from, e.value.to)],
          sort: true,
        });
      }
      if (e.is(removeInlineElement)) {
        decos = decos.update({
          filter: (from, to) => !(from === e.value.from && to === e.value.to),
        });
      }
    }

    return decos;
  },

  provide: (f) => EditorView.decorations.from(f),
});

// =============================================================================
// ATOMIC RANGES
// =============================================================================

/**
 * Makes inline element widgets atomic — cursor skips over them,
 * backspace deletes the whole widget (the \uFFFC char).
 */
export const inlineAtomicRanges = EditorView.atomicRanges.of((view) =>
  view.state.field(inlineElementsField),
);

// =============================================================================
// HELPERS
// =============================================================================

/** Extract all inline element data from the current editor state */
export function getInlineElements(state: EditorState): InlineElementData[] {
  const elements: InlineElementData[] = [];
  const decos = state.field(inlineElementsField);
  const cursor = decos.iter();
  while (cursor.value) {
    const data = cursor.value.spec.data as InlineElementData | undefined;
    if (data) {
      elements.push(data);
    }
    cursor.next();
  }
  return elements;
}

export interface InlineElementRange {
  from: number;
  to: number;
  data: InlineElementData;
}

/**
 * Extract inline elements with document ranges.
 * Useful for selection-aware clipboard operations.
 */
export function getInlineElementRanges(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): InlineElementRange[] {
  const ranges: InlineElementRange[] = [];
  const decos = state.field(inlineElementsField);
  decos.between(from, to, (decoFrom, decoTo, value) => {
    const data = value.spec.data as InlineElementData | undefined;
    if (!data) return;
    ranges.push({ from: decoFrom, to: decoTo, data });
  });
  return ranges;
}

/** Check if a document is already referenced in the editor */
export function hasReference(state: EditorState, documentId: string): boolean {
  const decos = state.field(inlineElementsField);
  const cursor = decos.iter();
  while (cursor.value) {
    const data = cursor.value.spec.data as InlineElementData | undefined;
    if (data?.type === "reference" && data.documentId === documentId) {
      return true;
    }
    cursor.next();
  }
  return false;
}

/** Build a transaction that inserts \uFFFC and adds the inline element decoration */
export function insertInlineElement(
  view: EditorView,
  pos: number,
  data: InlineElementData,
  replaceLength = 0,
): void {
  const from = pos;
  const to = pos + replaceLength;
  // Insert \uFFFC and add a trailing space only when needed.
  // This avoids creating duplicate separators if whitespace already follows.
  const suffix = shouldAppendTrailingSpace(view.state.doc, to) ? " " : "";
  const insertText = ORC + suffix;
  view.dispatch({
    changes: { from, to, insert: insertText },
    effects: addInlineElement.of({
      from,
      to: from + 1, // decoration covers the \uFFFC (1 char)
      data,
    }),
    // Move cursor after inserted token (+ optional separator)
    selection: { anchor: from + insertText.length },
  });
}

/**
 * Build a DecorationSet and the matching \uFFFC-containing text
 * for pre-populating the editor with references.
 * Returns { text, decorations } to be used with EditorState.create.
 */
export function buildInitialState(
  text: string,
  elements: Array<{ position: number; data: InlineElementData }>,
): { text: string; decorations: Range<Decoration>[] } {
  // Sort by position descending so inserts don't shift subsequent positions
  const sorted = [...elements].sort((a, b) => b.position - a.position);
  let result = text;
  const decoRanges: Range<Decoration>[] = [];

  for (const el of sorted) {
    // Insert \uFFFC at the specified position
    result = result.slice(0, el.position) + ORC + result.slice(el.position);
  }

  // Now build decoration ranges (positions shifted by earlier inserts, so re-sort ascending)
  const ascending = [...elements].sort((a, b) => a.position - b.position);
  let offset = 0;
  for (const el of ascending) {
    const pos = el.position + offset;
    const widget = new ElementWidget(el.data);
    const deco = Decoration.replace({
      widget,
      inclusive: false,
      data: el.data,
    });
    decoRanges.push(deco.range(pos, pos + 1));
    offset += 1; // each \uFFFC adds 1 char
  }

  return { text: result, decorations: decoRanges };
}
