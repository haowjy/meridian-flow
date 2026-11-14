/**
 * Where copied, pasted and moved blocks sit. A block's nesting names its whole chain of
 * containers, so blocks that leave their place first lose the steps outside them (`detach`),
 * then take the steps of where they land: a paste takes the caret's block's, a block move
 * keeps its depth under the block above it (`landingBase`).
 */
import {
  detach,
  innermostListStep,
  landingBase,
  pathOf,
  readPath,
  type Step,
} from "@meridian/prosemirror-schema";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos, Slice } from "@tiptap/pm/model";

import { NO_LIST } from "./nesting-commands";

function listed(steps: readonly Step[]): boolean {
  return steps.some((step) => step.type === "list");
}

function withPath(node: ProseMirrorNode, steps: readonly Step[], extra: object = {}) {
  const attrs = { ...node.attrs, path: pathOf(steps), ...extra, ...(listed(steps) ? {} : NO_LIST) };
  return node.type.create(attrs, node.content, node.marks);
}

/** A copy of the item's own task state for a block made beside it: a new task starts open. */
export function freshMarker(marker: unknown): unknown {
  return marker === "done" ? "todo" : marker;
}

/** Blocks the slice carries whole, in order, with their nesting detached. */
function detachedBlocks(nodes: readonly ProseMirrorNode[]): ProseMirrorNode[] {
  const paths = detach(nodes.map((node) => readPath(node.attrs.path)));
  return nodes.map((node, i) => withPath(node, paths[i]));
}

/** Nodes of a run of sibling blocks, moved below `above` (null at the start of the sequence). */
export function moveUnder(
  nodes: readonly ProseMirrorNode[],
  above: ProseMirrorNode | null,
): ProseMirrorNode[] {
  const first = readPath(nodes[0]?.attrs.path);
  const depth = first.filter((step) => step.type === "list").length;
  const base = landingBase(above ? readPath(above.attrs.path) : null, depth);
  const detached = detachedBlocks(nodes);
  return detached.map((node) => withPath(node, [...base, ...readPath(node.attrs.path)]));
}

/**
 * Blocks pasted or dropped into `caret`'s block. A block with a list level of its own lands
 * beside the caret's item; a block without one becomes what Enter would make there: the
 * caret's item kind and task state, a new task open.
 */
function landAt(nodes: readonly ProseMirrorNode[], caret: ProseMirrorNode): ProseMirrorNode[] {
  const caretSteps = readPath(caret.attrs.path).map((step) => ({ ...step, fresh: false }));
  const caretList = innermostListStep(caretSteps);
  const beside = caretList < 0 ? caretSteps : caretSteps.slice(0, caretList);
  return detachedBlocks(nodes).map((node) => {
    const own = readPath(node.attrs.path);
    if (listed(own) || caretList < 0) return withPath(node, [...beside, ...own]);
    return withPath(node, [...caretSteps, ...own], {
      kind: caret.attrs.kind,
      marker: freshMarker(caret.attrs.marker),
      loose: caret.attrs.loose,
      start: null,
    });
  });
}

function carriesNesting(node: ProseMirrorNode): boolean {
  return node.type.spec.attrs?.path !== undefined;
}

function mapBlocks(
  slice: Slice,
  map: (nodes: ProseMirrorNode[]) => ProseMirrorNode[],
): Slice | null {
  const nodes: ProseMirrorNode[] = [];
  slice.content.forEach((node) => {
    nodes.push(node);
  });
  if (nodes.length === 0 || !nodes.every(carriesNesting)) return null;
  return new Slice(Fragment.fromArray(map(nodes)), slice.openStart, slice.openEnd);
}

/** A pasted or dropped slice, nested where it lands at `$dest`. */
export function landSlice(slice: Slice, $dest: ResolvedPos): Slice {
  const caret = $dest.parent.isTextblock ? $dest.parent : $dest.nodeAfter;
  if (!caret || !carriesNesting(caret)) return slice;
  return mapBlocks(slice, (nodes) => landAt(nodes, caret)) ?? slice;
}

/**
 * What a copy carries. Words from inside one block are words: the block's place in its list
 * stays behind. Whole blocks keep their shape relative to each other, not to the document.
 */
export function copiedSlice(slice: Slice): Slice {
  const single = slice.content.childCount === 1 && slice.openStart > 0 && slice.openEnd > 0;
  return (
    mapBlocks(slice, (nodes) =>
      single ? nodes.map((node) => withPath(node, [])) : detachedBlocks(nodes),
    ) ?? slice
  );
}
