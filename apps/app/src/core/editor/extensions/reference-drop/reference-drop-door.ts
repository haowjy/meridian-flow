import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { endUndoStep } from "../../editor-history";

import type { DropDoor, DropPlan } from "../../landing/drop-plan";
import { snapOutOfChip, snapOutOfCode, snapToWordEdge } from "../../landing/inline-snap";
import type { Landing } from "../../landing/point-landing";

export type ReferenceDropEntry = Readonly<{
  ref: Readonly<{ kind: "file" | "folder"; id: string }>;
}>;

export type ReferenceDropRefusalReason = "unavailable" | "code";

export type ReferenceDropOptions = {
  draggedEntries: (event: DragEvent) => readonly ReferenceDropEntry[] | null;
  content: (schema: Schema, entries: readonly ReferenceDropEntry[]) => readonly PMNode[] | null;
  label: (kind: "accept" | ReferenceDropRefusalReason) => string;
};

export function referenceDropDoor(options: ReferenceDropOptions): DropDoor {
  return {
    plan: ({ view }, landing, event) => {
      const refuse = (reason: ReferenceDropRefusalReason): DropPlan => ({
        kind: "refuse",
        hint: options.label(reason),
      });
      const entries = options.draggedEntries(event);
      if (!entries?.length) return refuse("unavailable");
      const nodes = options.content(view.state.schema, entries);
      if (!nodes || nodes.length !== entries.length) return refuse("unavailable");
      if (landing.kind === "source") return refuse("code");
      const placed = placeNodes(view, landing, nodes);
      if (!placed) return refuse("unavailable");
      return {
        kind: "accept",
        pos: placed.pos,
        hint: options.label("accept"),
        effect: "copy",
        commit: placed.commit,
      };
    },
  };
}

export type NodePlacement = { pos: number; commit(view: EditorView): void };

export function placeNodes(
  view: EditorView,
  landing: Exclude<Landing, { kind: "source" }>,
  nodes: readonly PMNode[],
): NodePlacement | null {
  if (landing.kind === "seam") {
    const paragraph = view.state.schema.nodes.paragraph;
    const content = Fragment.fromArray(separated(view, nodes));
    if (!paragraph?.validContent(content)) return null;
    const block = paragraph.create(null, content);
    return {
      pos: landing.pos,
      commit: (target) => insert(target, landing.pos, block, (end) => end - 1),
    };
  }
  const { doc } = view.state;
  const pos = snapToWordEdge(doc, snapOutOfChip(doc, snapOutOfCode(doc, landing.pos)));
  const content = spaced(view, pos, nodes);
  if (!content) return null;
  return { pos, commit: (target) => insert(target, pos, content, (end) => end) };
}

function separated(view: EditorView, nodes: readonly PMNode[]): PMNode[] {
  return nodes.flatMap((node, index) => (index > 0 ? [view.state.schema.text(" "), node] : [node]));
}

function spaced(view: EditorView, pos: number, nodes: readonly PMNode[]): Fragment | null {
  if (nodes.some((node) => !node.isInline)) return null;
  const { doc, schema } = view.state;
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if (nodes.some((node) => !parent.type.allowsMarks(node.marks))) return null;

  const before = pos > $pos.start() ? doc.textBetween(pos - 1, pos, "\0", "\0") : "";
  const after = pos < $pos.end() ? doc.textBetween(pos, pos + 1, "\0", "\0") : "";
  const content = separated(view, nodes);
  if (before && !/\s/u.test(before)) content.unshift(schema.text(" "));
  if (after && !/\s/u.test(after)) content.push(schema.text(" "));
  const fragment = Fragment.fromArray(content);
  return parent.canReplace($pos.index(), $pos.index(), fragment) ? fragment : null;
}

function insert(
  view: EditorView,
  pos: number,
  content: Fragment | PMNode,
  caretFrom: (end: number) => number,
): void {
  endUndoStep(view.state);
  const transaction = view.state.tr.insert(pos, content);
  const end = transaction.mapping.map(pos, 1);
  transaction.setSelection(TextSelection.create(transaction.doc, caretFrom(end)));
  // A chip named like a host ("notes.zip", "a.io") is a link already. Neither autolink nor the
  // paste rules a `uiEvent: "drop"` would wake may turn it into a website.
  transaction.setMeta("preventAutolink", true);
  view.dispatch(transaction.scrollIntoView());
  endUndoStep(view.state);
  view.focus();
}
