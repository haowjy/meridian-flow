/**
 * @-Mention Detection — StateField
 *
 * Pure detection logic + CM6 StateField that reactively computes @-mention
 * state from editor state. The field is read by ComposerEditor's unified
 * update listener, which bridges the value into React.
 *
 * Why StateField instead of a callback-based updateListener:
 * A separate updateListener closure failed to resolve the React ref at call
 * time (StrictMode / HMR stale closure). By moving detection into a field,
 * we read the result from the same listener that already works for
 * onContentChange — same closure, proven code path.
 */

import { EditorState, StateField } from "@codemirror/state";

// =============================================================================
// TYPES
// =============================================================================

export interface AtMentionState {
  /** Whether an @-mention pattern is active */
  isActive: boolean;
  /** Text after @ (empty string when just "@" typed) */
  query: string;
  /** Position of the @ character in the document */
  atPos: number;
  /** Current cursor position (end of query) */
  cursorPos: number;
}

// =============================================================================
// PURE DETECTION
// =============================================================================

/**
 * Detect an @-mention pattern at the cursor position.
 *
 * Pattern: `@` at start of line or after whitespace, followed by optional
 * non-whitespace chars up to the cursor position.
 *
 * Pure function — usable outside CM6 (tests, other contexts).
 */
export function detectAtMention(state: EditorState): AtMentionState | null {
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const textBeforeCursor = state.doc.sliceString(line.from, cursor);

  // Match @<query> where @ is at start of line or after whitespace
  const match = textBeforeCursor.match(/(^|[\s])@(\S*)$/);
  if (!match) return null;

  const atIndexInText = textBeforeCursor.lastIndexOf("@");
  const atPos = line.from + atIndexInText;
  const query = match[2] ?? "";

  return {
    isActive: true,
    query,
    atPos,
    cursorPos: cursor,
  };
}

// =============================================================================
// STATE FIELD
// =============================================================================

/**
 * CM6 StateField that holds the current @-mention detection result.
 *
 * Only recomputes when the document or selection changes (reference-stable
 * otherwise). ComposerEditor's update listener reads this field to bridge
 * the value into React.
 */
export const atMentionField = StateField.define<AtMentionState | null>({
  create(state) {
    return detectAtMention(state);
  },
  update(prev, tr) {
    // Only recompute when doc or selection changed
    if (!tr.docChanged && !tr.selection) return prev;
    return detectAtMention(tr.state);
  },
});
