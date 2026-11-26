import { innermostListStep, isNested, pathOf, readPath } from "@meridian/prosemirror-schema";
import type { ResolvedPos } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { NO_LIST, outdent, selectedSequence } from "./nesting-commands";
import { freshMarker } from "./nesting-landing";

type Dispatch = ((tr: Transaction) => void) | undefined;

function nestedBlockAt($from: ResolvedPos) {
  const block = $from.parent;
  if (!block.isTextblock || !isNested(block.attrs.path)) return null;
  const sequence = selectedSequence(TextSelection.create($from.doc, $from.pos));
  return { block, pos: $from.before(), facts: sequence.facts[sequence.from], $from };
}

function caretBlock(state: EditorState) {
  return state.selection instanceof TextSelection ? nestedBlockAt(state.selection.$from) : null;
}

function lift(tr: Transaction): boolean {
  const { $from } = tr.selection;
  const block = $from.parent;
  const steps = readPath(block.attrs.path);
  const sequence = selectedSequence(tr.selection);
  const facts = sequence.facts[sequence.from];
  const level = innermostListStep(facts.steps);
  if (level === steps.length - 1 && facts.steps[level].startsItem) return outdent(tr);
  steps.pop();
  const listed = steps.some((step) => step.type === "list");
  tr.setNodeMarkup($from.before(), undefined, {
    ...block.attrs,
    path: pathOf(steps),
    ...(listed ? {} : NO_LIST),
  });
  return true;
}

export function enterInNesting(state: EditorState, dispatch: Dispatch): boolean {
  if (!caretBlock(state)) return false;
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  const caret = nestedBlockAt(tr.selection.$from);
  if (!caret) return false;
  const { block, $from } = caret;

  if (state.selection.empty && block.content.size === 0) {
    if (!lift(tr)) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  }

  const attrs = block.attrs;
  const continuing = {
    ...attrs,
    path: pathOf(readPath(attrs.path).map((step) => ({ ...step, fresh: false }))),
    start: null,
  };
  const atStart = $from.parentOffset === 0 && $from.parent.content.size > 0;
  const atEnd = $from.parentOffset === $from.parent.content.size;
  const marks = state.storedMarks ?? ($from.parentOffset > 0 ? $from.marks() : null);
  if (atStart) {
    tr.split($from.pos, 1, [{ type: block.type, attrs: continuing }]);
    tr.setNodeMarkup($from.before(), undefined, { ...attrs, marker: freshMarker(attrs.marker) });
  } else {
    const level = atEnd && "level" in attrs ? { level: null } : {};
    tr.split($from.pos, 1, [
      { type: block.type, attrs: { ...continuing, ...level, marker: freshMarker(attrs.marker) } },
    ]);
  }
  if (marks) tr.ensureMarks(marks);
  dispatch?.(tr.scrollIntoView());
  return true;
}

export function backspaceInNesting(state: EditorState, dispatch: Dispatch): boolean {
  const caret = caretBlock(state);
  if (!caret || !state.selection.empty || caret.$from.parentOffset !== 0) return false;
  const { block, pos, facts } = caret;
  const steps = readPath(block.attrs.path);
  const innermost = facts.steps[steps.length - 1];
  if (!innermost) return false;
  const tr = state.tr;
  if (innermost.opens) {
    if (!lift(tr)) return false;
  } else if (innermost.type === "list" && innermost.startsItem) {
    tr.setNodeMarkup(pos, undefined, { ...block.attrs, marker: null });
  } else return false;
  dispatch?.(tr.scrollIntoView());
  return true;
}

export function toggleTaskAt(tr: Transaction, pos: number): boolean {
  const node = tr.doc.nodeAt(pos);
  if (!node) return false;
  const sequence = selectedSequence(TextSelection.near(tr.doc.resolve(pos + 1)));
  const marker = sequence.facts[sequence.from]?.marker;
  if (marker !== "todo" && marker !== "done") return false;
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, marker: marker === "done" ? "todo" : "done" });
  return true;
}

export function toggleTaskAtCaret(state: EditorState, dispatch: Dispatch): boolean {
  const caret = caretBlock(state);
  if (!caret) return false;
  const tr = state.tr;
  const selection = state.selection;
  if (!toggleTaskAt(tr, caret.pos)) return false;
  tr.setSelection(selection.map(tr.doc, tr.mapping));
  dispatch?.(tr);
  return true;
}
