/** Turns Meridian tree-row drags into the references a writing surface already inserts. */

import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { tableDropDecision } from "../../table-drop";
import { DropCaretView } from "../drop-caret";

export const MERIDIAN_ENTRIES_MIME = "application/x-meridian-entries";

export type ReferenceDropEntry = Readonly<{
  ref: Readonly<{ kind: "file" | "folder"; id: string }>;
}>;

export type ReferenceDropVerdict =
  | { kind: "accept"; label: string }
  | { kind: "refuse"; label: string };

export type ReferenceDropOptions = {
  activeDrag: () => readonly ReferenceDropEntry[] | null;
  /** Resolves identities through the host's live `@` catalog and builds its exact node shape. */
  content: (schema: Schema, entries: readonly ReferenceDropEntry[]) => readonly PMNode[] | null;
  label: (kind: "accept" | "unavailable" | "invalid-landing") => string;
  showHint: (
    owner: string,
    verdict: ReferenceDropVerdict,
    point: { clientX: number; clientY: number },
  ) => void;
  clearHint: (owner: string) => void;
};

let ownerSequence = 0;

export function draggingMeridianEntries(event: Pick<DragEvent, "dataTransfer">): boolean {
  const transfer = event.dataTransfer;
  return Boolean(
    transfer &&
      transfer.files.length === 0 &&
      Array.from(transfer.types).includes(MERIDIAN_ENTRIES_MIME),
  );
}

type AcceptedPlan = { kind: "accept"; label: string; pos: number; content: Fragment };
type PreparedPlan = AcceptedPlan | { kind: "refuse"; label: string };

function basicWordCharacter(value: string): boolean {
  return /[\p{L}\p{M}\p{N}_]/u.test(value);
}

function characterAt(view: EditorView, pos: number): string {
  return view.state.doc.textBetween(pos, pos + 1, "\0", "\0");
}

function wordCharacterAt(view: EditorView, pos: number, start: number, end: number): boolean {
  const character = characterAt(view, pos);
  if (basicWordCharacter(character)) return true;
  return (
    pos > start &&
    pos + 1 < end &&
    /['’\-‐‑]/u.test(character) &&
    basicWordCharacter(characterAt(view, pos - 1)) &&
    basicWordCharacter(characterAt(view, pos + 1))
  );
}

/** A pointer inside a word chooses the nearer edge; punctuation and whitespace keep their position. */
function snapToWordEdge(view: EditorView, pos: number): number {
  const $pos = view.state.doc.resolve(pos);
  if (
    !$pos.parent.isTextblock ||
    $pos.parentOffset === 0 ||
    $pos.parentOffset === $pos.parent.content.size
  )
    return pos;
  const start = pos - $pos.parentOffset;
  const end = start + $pos.parent.content.size;
  if (!wordCharacterAt(view, pos - 1, start, end) || !wordCharacterAt(view, pos, start, end))
    return pos;
  let before = pos;
  let after = pos;
  while (before > start && wordCharacterAt(view, before - 1, start, end)) before -= 1;
  while (after < end && wordCharacterAt(view, after, start, end)) after += 1;
  return pos - before <= after - pos ? before : after;
}

function landingAt(view: EditorView, event: DragEvent): number | null {
  const decision = tableDropDecision(view, { x: event.clientX, y: event.clientY });
  if (decision.kind === "refuse") return null;
  const raw =
    decision.kind === "snap"
      ? decision.pos
      : view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (raw === undefined) return null;
  const pos = snapToWordEdge(view, raw);
  const $pos = view.state.doc.resolve(pos);
  return $pos.parent.isTextblock && !$pos.parent.type.spec.code ? pos : null;
}

function spacedContent(view: EditorView, pos: number, nodes: readonly PMNode[]): Fragment | null {
  if (nodes.length === 0 || nodes.some((node) => !node.isInline)) return null;
  const $pos = view.state.doc.resolve(pos);
  const parent = $pos.parent;
  if (nodes.some((node) => !parent.type.allowsMarks(node.marks))) return null;

  const before = pos > $pos.start() ? characterAt(view, pos - 1) : "";
  const after = pos < $pos.end() ? characterAt(view, pos) : "";
  const content: PMNode[] = [];
  if (before && !/\s/u.test(before)) content.push(view.state.schema.text(" "));
  nodes.forEach((node, index) => {
    if (index > 0) content.push(view.state.schema.text(" "));
    content.push(node);
  });
  if (after && !/\s/u.test(after)) content.push(view.state.schema.text(" "));
  const fragment = Fragment.fromArray(content);
  return parent.canReplace($pos.index(), $pos.index(), fragment) ? fragment : null;
}

function prepare(view: EditorView, event: DragEvent, options: ReferenceDropOptions): PreparedPlan {
  const entries = options.activeDrag();
  if (!entries?.length) return { kind: "refuse", label: options.label("unavailable") };
  const nodes = options.content(view.state.schema, entries);
  if (!nodes || nodes.length !== entries.length)
    return { kind: "refuse", label: options.label("unavailable") };
  const pos = landingAt(view, event);
  if (pos === null) return { kind: "refuse", label: options.label("invalid-landing") };
  const content = spacedContent(view, pos, nodes);
  return content
    ? { kind: "accept", label: options.label("accept"), pos, content }
    : { kind: "refuse", label: options.label("invalid-landing") };
}

function referenceDropPlugin(options: ReferenceDropOptions): Plugin {
  const owner = `reference-drop:${++ownerSequence}`;
  const preparedEvents = new WeakMap<DragEvent, PreparedPlan | null>();
  const planAt = (view: EditorView, event: DragEvent): PreparedPlan | null => {
    if (preparedEvents.has(event)) return preparedEvents.get(event) ?? null;
    if (!view.editable || view.dragging || !draggingMeridianEntries(event)) {
      options.clearHint(owner);
      preparedEvents.set(event, null);
      return null;
    }
    const plan = prepare(view, event, options);
    options.showHint(owner, { kind: plan.kind, label: plan.label }, event);
    preparedEvents.set(event, plan);
    return plan;
  };

  return new Plugin({
    view: (view) =>
      new DropCaretView(view, (current, event) => {
        const plan = planAt(current, event);
        return plan?.kind === "accept" ? plan.pos : null;
      }),
    props: {
      handleDrop(view, event) {
        if (!draggingMeridianEntries(event) || view.dragging || !view.editable) return false;
        event.preventDefault();
        event.stopPropagation();
        const plan = prepare(view, event, options);
        options.clearHint(owner);
        if (plan.kind === "refuse") return true;

        yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
        const transaction = closeHistory(view.state.tr).insert(plan.pos, plan.content);
        const end = transaction.mapping.map(plan.pos, 1);
        transaction.setSelection(TextSelection.create(transaction.doc, end));
        transaction.setMeta("uiEvent", "drop");
        view.dispatch(transaction.scrollIntoView());
        yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
        view.focus();
        return true;
      },
      handleDOMEvents: {
        dragover(view, event) {
          const plan = planAt(view, event);
          if (!plan) return false;
          if (plan.kind === "accept") {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          } else if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
          return false;
        },
        dragleave(view, event) {
          if (!draggingMeridianEntries(event)) return false;
          const related = event.relatedTarget as Node | null;
          if (!related || !view.dom.contains(related)) options.clearHint(owner);
          return false;
        },
        dragend() {
          options.clearHint(owner);
          return false;
        },
      },
    },
  });
}

export const ReferenceDropExtension = Extension.create<ReferenceDropOptions>({
  name: "meridianReferenceDrop",

  addOptions: () => ({
    activeDrag: () => null,
    content: () => null,
    label: (kind) =>
      kind === "accept"
        ? "Mention"
        : kind === "unavailable"
          ? "Can’t mention that"
          : "Can’t mention there",
    showHint: () => {},
    clearHint: () => {},
  }),

  addProseMirrorPlugins() {
    return [referenceDropPlugin(this.options)];
  },
});
