/**
 * Typing an opener writes its closer; typing the closer walks back out of it.
 *
 * Three gestures, one mechanism, all of it reading
 * [`auto-pairs.ts`](auto-pairs.ts):
 *
 * - **open** — `[` inserts `[]` and leaves the caret between them, in one
 *   transaction, so one undo takes the whole gesture back;
 * - **step over** — the closer the writer types where this plugin already
 *   wrote one moves the caret past it instead of doubling it;
 * - **unpair** — Backspace between the two halves takes both.
 *
 * **The step is only ever over a closer this plugin wrote.** That is what the
 * plugin state holds: the positions of the closers it inserted, mapped forward
 * through every transaction and dropped the moment their position is deleted.
 * A writer's own `]` is their own text and typing `]` in front of it writes a
 * second one, which is what they asked for. Everything in this file fails
 * toward plain insertion — remote collab edits replace the whole document and
 * take the whole table with them (see `anchors.ts` for why positions cannot
 * survive that), and a keystroke that lands as itself is a far smaller cost
 * than a keystroke that disappears.
 *
 * Positions are held only across transactions that map them, never read back
 * from a stale state: every step and every unpair re-reads the character in
 * the document before trusting the entry that pointed at it.
 */

import { Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";

import {
  type AutoPairSpec,
  autoPairForOpener,
  resolveAutoPairContext,
  shouldAutoClose,
} from "./auto-pairs";

const AUTO_PAIR_NAME = "meridianAutoPair";

/** A closer this plugin wrote, and where it sits in the current document. */
type AutoClosedPair = { pos: number; spec: AutoPairSpec };

type AutoPairState = { readonly closers: readonly AutoClosedPair[] };

type AutoPairEvent = { opened: AutoClosedPair } | { consumed: number };

export const autoPairPluginKey = new PluginKey<AutoPairState>(AUTO_PAIR_NAME);

const NOTHING_OPEN: AutoPairState = { closers: [] };

/**
 * A writer who opens far more pairs than they close is writing, not nesting.
 * The oldest entries are the ones they have typed past, so the table forgets
 * them rather than growing for the length of a session.
 */
const MAX_TRACKED_CLOSERS = 32;

/** The character immediately after the caret, or null at the block's end. */
function characterAfter($pos: ResolvedPos): string | null {
  const node = $pos.nodeAfter;
  if (!node) return null;
  // An atom (an inline image) is something the caret sits in front of, not
  // empty room: `""` fails every "may close here" test, which is the answer.
  return node.isText ? (node.text?.[0] ?? "") : "";
}

/** The character immediately before the caret, or null at the block's start. */
function characterBefore($pos: ResolvedPos): string | null {
  const node = $pos.nodeBefore;
  if (!node) return null;
  return node.isText ? (node.text?.slice(-1) ?? "") : "";
}

function autoPairState(state: EditorState): AutoPairState {
  return autoPairPluginKey.getState(state) ?? NOTHING_OPEN;
}

/**
 * The closer this plugin wrote at `pos`, confirmed against the document.
 *
 * The confirmation is the whole safety of the feature: a mapped position that
 * no longer points at the character it was written for is stale state, and
 * stale state must never consume a keystroke.
 */
function autoClosedAt(state: EditorState, pos: number): AutoClosedPair | null {
  const entry = autoPairState(state).closers.find((candidate) => candidate.pos === pos);
  if (!entry) return null;
  const end = pos + entry.spec.close.length;
  if (end > state.doc.content.size) return null;
  return state.doc.textBetween(pos, end) === entry.spec.close ? entry : null;
}

/**
 * How many closers this plugin wrote sit in an unbroken run at `pos`.
 *
 * A surface that replaces a range the writer typed — the `[[` menu replacing
 * its own trigger text — has to replace the closers that came with it too, or
 * it leaves `]]` stranded after the link it just wrote.
 */
export function autoClosedRunLength(state: EditorState, pos: number): number {
  let length = 0;
  for (;;) {
    const entry = autoClosedAt(state, pos + length);
    if (!entry) return length;
    length += entry.spec.close.length;
  }
}

/** `[` here means `[]` with the caret in the middle. */
function openPairTransaction(state: EditorState, at: number, typed: string): Transaction | null {
  const $at = state.doc.resolve(at);
  const context = resolveAutoPairContext($at, state.storedMarks);
  if (!context) return null;

  const spec = autoPairForOpener(typed, context);
  if (!spec) return null;
  if (!shouldAutoClose(spec, characterBefore($at), characterAfter($at))) return null;

  const tr = state.tr.insertText(spec.open + spec.close, at, at);
  const closerPos = at + spec.open.length;
  tr.setSelection(TextSelection.create(tr.doc, closerPos));
  tr.setMeta(autoPairPluginKey, { opened: { pos: closerPos, spec } } satisfies AutoPairEvent);
  return tr.scrollIntoView();
}

/** `]` in front of an `]` this plugin wrote is a step, not a character. */
function stepOverTransaction(state: EditorState, at: number, typed: string): Transaction | null {
  const entry = autoClosedAt(state, at);
  if (!entry || entry.spec.close !== typed) return null;

  const tr = state.tr.setSelection(TextSelection.create(state.doc, at + entry.spec.close.length));
  tr.setMeta(autoPairPluginKey, { consumed: at } satisfies AutoPairEvent);
  return tr.scrollIntoView();
}

/** Backspace between the halves of a pair this plugin wrote takes both. */
function unpairTransaction(state: EditorState): Transaction | null {
  const { empty, $from } = state.selection;
  if (!empty) return null;

  const entry = autoClosedAt(state, $from.pos);
  if (!entry) return null;

  const from = $from.pos - entry.spec.open.length;
  // `start()` keeps the read inside the caret's own block: an opener is only
  // an opener when it is in the same text the closer is in.
  if (from < $from.start() || state.doc.textBetween(from, $from.pos) !== entry.spec.open) {
    return null;
  }

  const tr = state.tr.delete(from, $from.pos + entry.spec.close.length);
  tr.setMeta(autoPairPluginKey, { consumed: $from.pos } satisfies AutoPairEvent);
  return tr.scrollIntoView();
}

export const AutoPairExtension = Extension.create({
  name: AUTO_PAIR_NAME,

  addKeyboardShortcuts() {
    return {
      /**
       * Refusing when there is no pair to take leaves the rest of the
       * Backspace chain — the autoformat's `undoInputRule`, the list and
       * fence bindings, the base keymap — exactly as it was.
       */
      Backspace: () => {
        const tr = unpairTransaction(this.editor.state);
        if (!tr) return false;
        this.editor.view.dispatch(tr);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<AutoPairState>({
        key: autoPairPluginKey,

        state: {
          init: () => NOTHING_OPEN,

          apply(tr, value) {
            const event = tr.getMeta(autoPairPluginKey) as AutoPairEvent | undefined;
            const consumed = event && "consumed" in event ? event.consumed : null;
            const closers: AutoClosedPair[] = [];

            for (const entry of value.closers) {
              if (entry.pos === consumed) continue;
              // Association to the right is what makes nesting work: text
              // inserted at an outer closer's position belongs before it, so
              // `[` inside `[]` leaves the outer `]` on the outside.
              const mapped = tr.mapping.mapResult(entry.pos, 1);
              // Deleted covers the case this feature exists to survive: a
              // remote peer's edit replaces the document wholesale and every
              // tracked position goes with it, leaving plain insertion.
              if (mapped.deleted) continue;
              closers.push({ pos: mapped.pos, spec: entry.spec });
            }

            if (event && "opened" in event) closers.push(event.opened);
            // The overwhelmingly common state is "no pair open", and keeping
            // its identity keeps this plugin off every transaction's cost.
            if (closers.length === 0 && value.closers.length === 0) return value;

            return { closers: closers.slice(-MAX_TRACKED_CLOSERS) };
          },
        },

        props: {
          /**
           * One character, no selection, no composition. A paste arrives as a
           * slice rather than text input; an IME is mid-word and dispatching
           * underneath it corrupts the composition — both are somebody else's
           * keystroke and this plugin declines them.
           */
          handleTextInput(view, from, to, text) {
            if (from !== to || text.length !== 1 || view.composing) return false;

            const transaction =
              stepOverTransaction(view.state, from, text) ??
              openPairTransaction(view.state, from, text);
            if (!transaction) return false;

            view.dispatch(transaction);
            return true;
          },
        },
      }),
    ];
  },
});
