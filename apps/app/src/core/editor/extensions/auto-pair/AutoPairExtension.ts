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

type AutoClosedPair = { pos: number; spec: AutoPairSpec };

type AutoPairState = { readonly closers: readonly AutoClosedPair[] };

type AutoPairEvent = { opened: AutoClosedPair } | { consumed: number };

export const autoPairPluginKey = new PluginKey<AutoPairState>(AUTO_PAIR_NAME);

const NOTHING_OPEN: AutoPairState = { closers: [] };

const MAX_TRACKED_CLOSERS = 32;

function characterAfter($pos: ResolvedPos): string | null {
  const node = $pos.nodeAfter;
  if (!node) return null;
  return node.isText ? (node.text?.[0] ?? "") : "";
}

function characterBefore($pos: ResolvedPos): string | null {
  const node = $pos.nodeBefore;
  if (!node) return null;
  return node.isText ? (node.text?.slice(-1) ?? "") : "";
}

function autoPairState(state: EditorState): AutoPairState {
  return autoPairPluginKey.getState(state) ?? NOTHING_OPEN;
}

function autoClosedAt(state: EditorState, pos: number): AutoClosedPair | null {
  const entry = autoPairState(state).closers.find((candidate) => candidate.pos === pos);
  if (!entry) return null;
  const end = pos + entry.spec.close.length;
  if (end > state.doc.content.size) return null;
  return state.doc.textBetween(pos, end) === entry.spec.close ? entry : null;
}

/**
 * The caret this keystroke lands at, or null when it is replacing something.
 *
 * ProseMirror reports the range the typed text replaces, and that range is
 * routinely wider than a caret even when nothing is being destroyed. Typing
 * into an empty paragraph swaps the block's trailing `<br>` for the character,
 * and the diff read back from the DOM is the whole block; select-all followed
 * by Backspace leaves the selection spanning the emptied document, and the
 * next character arrives against that. Both were the writer's first keystroke
 * on a blank page, and both stopped pairing while this only trusted a caret.
 *
 * So the question is not how wide the range is but whether it holds anything:
 * a range with no text in it destroys nothing, and when it is one text block
 * the character belongs inside that block. A range carrying text is a real
 * replacement and belongs to whoever wants it.
 */
function insertionCaret(state: EditorState, from: number, to: number): number | null {
  const { selection } = state;
  if (selection.empty && from <= selection.from && selection.from <= to) return selection.from;

  if (state.doc.textBetween(from, to, "", "") !== "") return null;

  const caret = TextSelection.near(state.doc.resolve(from), 1);
  if (!caret.empty) return null;
  return from >= caret.$from.before() && to <= caret.$from.after() ? caret.from : null;
}

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

function stepOverTransaction(state: EditorState, at: number, typed: string): Transaction | null {
  const entry = autoClosedAt(state, at);
  if (!entry || entry.spec.close !== typed) return null;

  const tr = state.tr.setSelection(TextSelection.create(state.doc, at + entry.spec.close.length));
  tr.setMeta(autoPairPluginKey, { consumed: at } satisfies AutoPairEvent);
  return tr.scrollIntoView();
}

function unpairTransaction(state: EditorState): Transaction | null {
  const { empty, $from } = state.selection;
  if (!empty) return null;

  const entry = autoClosedAt(state, $from.pos);
  if (!entry) return null;

  const from = $from.pos - entry.spec.open.length;
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
              const mapped = tr.mapping.mapResult(entry.pos, 1);
              if (mapped.deleted) continue;
              closers.push({ pos: mapped.pos, spec: entry.spec });
            }

            if (event && "opened" in event) closers.push(event.opened);
            if (closers.length === 0 && value.closers.length === 0) return value;

            return { closers: closers.slice(-MAX_TRACKED_CLOSERS) };
          },
        },

        props: {
          /**
           * One character, no composition, nothing being replaced. A paste
           * arrives as a slice rather than text input; an IME is mid-word and
           * dispatching underneath it corrupts the composition — both are
           * somebody else's keystroke and this plugin declines them.
           */
          handleTextInput(view, from, to, text) {
            if (text.length !== 1 || view.composing) return false;

            const at = insertionCaret(view.state, from, to);
            if (at === null) return false;

            const transaction =
              stepOverTransaction(view.state, at, text) ??
              openPairTransaction(view.state, at, text);
            if (!transaction) return false;

            view.dispatch(transaction);
            return true;
          },
        },
      }),
    ];
  },
});
