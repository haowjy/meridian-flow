/**
 * The reference door: what dropping project-tree rows on a writing surface
 * does. Rows become the same chips `@` writes, at the landing: in a paragraph
 * of their own at a seam, beside (never inside) a word, a chip or a code span
 * in text, and nowhere in a code block.
 */

import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

import type { DropLandingOptions } from "../../landing/DropLandingExtension";
import type { DropHint, DropPlan } from "../../landing/drop-plan";
import {
  snapOutOfAtom,
  snapOutOfCode,
  snapOutOfIdentityLink,
  snapToWordEdge,
} from "../../landing/inline-snap";
import type { Landing, Point } from "../../landing/point-landing";
import { viewGeometry } from "../../landing/view-geometry";

export type ReferenceDropEntry = Readonly<{
  ref: Readonly<{ kind: "file" | "folder"; id: string }>;
}>;

export type ReferenceDropRefusalReason = "unavailable" | "code";

export type ReferenceDropOptions = {
  activeDrag: () => readonly ReferenceDropEntry[] | null;
  /** Resolves identities through the host's live `@` catalog and builds its exact node shape. */
  content: (schema: Schema, entries: readonly ReferenceDropEntry[]) => readonly PMNode[] | null;
  label: (kind: "accept" | ReferenceDropRefusalReason) => string;
  showHint: (owner: string, hint: DropHint, point: { clientX: number; clientY: number }) => void;
  clearHint: (owner: string) => void;
};

/** The row door's options for `DropLandingExtension`: the plan, and the hint it is shown with. */
export function referenceDropDoor(
  options: ReferenceDropOptions,
): Pick<DropLandingOptions, "entries" | "hint"> {
  return {
    entries: referenceDropPlan(options),
    hint: { show: options.showHint, clear: options.clearHint },
  };
}

/** The plan for a row drag at `landing`; `point` is where the pointer is. */
function referenceDropPlan(options: ReferenceDropOptions) {
  return (view: EditorView, landing: Landing, point: Point): DropPlan => {
    const refuse = (reason: ReferenceDropRefusalReason): DropPlan => ({
      kind: "refuse",
      hint: options.label(reason),
    });
    const entries = options.activeDrag();
    if (!entries?.length) return refuse("unavailable");
    const nodes = options.content(view.state.schema, entries);
    if (!nodes || nodes.length !== entries.length) return refuse("unavailable");
    if (landing.kind === "source") return refuse("code");

    const hint = options.label("accept");
    if (landing.kind === "seam") {
      const paragraph = view.state.schema.nodes.paragraph;
      const content = Fragment.fromArray(separated(view, nodes));
      const $seam = view.state.doc.resolve(landing.pos);
      if (
        !paragraph?.validContent(content) ||
        !$seam.parent.canReplaceWith($seam.index(), $seam.index(), paragraph)
      )
        return refuse("unavailable");
      const block = paragraph.create(null, content);
      return {
        kind: "accept",
        pos: landing.pos,
        hint,
        commit: (target) => insert(target, landing.pos, block, (end) => end - 1),
      };
    }

    const { doc } = view.state;
    const pos = snapToWordEdge(
      doc,
      snapOutOfIdentityLink(
        doc,
        snapOutOfAtom(doc, snapOutOfCode(doc, landing.pos), point, viewGeometry(view)),
      ),
    );
    const content = spaced(view, pos, nodes);
    if (!content) return refuse("unavailable");
    return {
      kind: "accept",
      pos,
      hint,
      commit: (target) => insert(target, pos, content, (end) => end),
    };
  };
}

function separated(view: EditorView, nodes: readonly PMNode[]): PMNode[] {
  return nodes.flatMap((node, index) => (index > 0 ? [view.state.schema.text(" "), node] : [node]));
}

/** The chips at `pos`, with a space on a side that touches a non-space. */
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

/** One undo step for the drop, the caret after it. */
function insert(
  view: EditorView,
  pos: number,
  content: Fragment | PMNode,
  caretFrom: (end: number) => number,
): void {
  yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
  const transaction = closeHistory(view.state.tr).insert(pos, content);
  const end = transaction.mapping.map(pos, 1);
  transaction.setSelection(TextSelection.create(transaction.doc, caretFrom(end)));
  transaction.setMeta("uiEvent", "drop");
  view.dispatch(transaction.scrollIntoView());
  yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
  view.dispatch(closeHistory(view.state.tr));
  view.focus();
}
