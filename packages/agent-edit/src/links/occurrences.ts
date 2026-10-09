/**
 * Rebuilding ProseMirror nodes with new attrs for some of their link
 * occurrences (links, `image`, `figure`), found by `walkLinkOccurrences`.
 *
 * Only the named occurrences change: a link run's text nodes get a new link
 * mark, an image or figure gets a new `src`/`ref`. Every other node is
 * reused, so an unchanged block stays `.eq` to its old self.
 */
import type { LinkOccurrence, PMNode } from "@meridian/markup";
import { Fragment, type Mark } from "prosemirror-model";

/** Stored link attrs; an image or figure's `src` travels as `href`. */
export interface OccurrenceAttrs {
  ref: string | null;
  href: string;
  title: string | null;
}

interface Edit {
  path: readonly number[];
  count: number;
  attrs: OccurrenceAttrs;
}

/**
 * `occurrences` must be `walkLinkOccurrences(blocks)`; `attrs[i]` replaces
 * occurrence `i`'s attrs, `null` keeps it.
 */
export function rebuildOccurrences(
  blocks: readonly PMNode[],
  occurrences: readonly LinkOccurrence[],
  attrs: readonly (OccurrenceAttrs | null)[],
): PMNode[] {
  const byBlock = new Map<number, Edit[]>();
  occurrences.forEach((occurrence, index) => {
    const next = attrs[index];
    if (!next || sameAttrs(next, occurrence.attrs)) return;
    const edits = byBlock.get(occurrence.at.block) ?? [];
    edits.push({ path: occurrence.at.path, count: occurrence.at.count, attrs: next });
    byBlock.set(occurrence.at.block, edits);
  });
  if (byBlock.size === 0) return [...blocks];
  return blocks.map((block, index) => {
    const edits = byBlock.get(index);
    return edits ? rebuildNode(block, edits) : block;
  });
}

function rebuildNode(node: PMNode, edits: readonly Edit[]): PMNode {
  const self = edits.find((edit) => edit.path.length === 0);
  if (self) return withSource(node, self.attrs);
  const children: PMNode[] = [];
  node.forEach((child) => {
    children.push(child);
  });
  const deeper = new Map<number, Edit[]>();
  for (const edit of edits) {
    const [index, ...rest] = edit.path;
    if (index === undefined) continue;
    if (rest.length === 0 && node.inlineContent) {
      // A link run starts here and covers `count` siblings; an image is one node.
      for (let offset = 0; offset < edit.count; offset += 1) {
        const child = children[index + offset];
        if (child) children[index + offset] = withLink(child, edit.attrs);
      }
      continue;
    }
    const nested = deeper.get(index) ?? [];
    nested.push({ ...edit, path: rest });
    deeper.set(index, nested);
  }
  for (const [index, nested] of deeper) {
    const child = children[index];
    if (child) children[index] = rebuildNode(child, nested);
  }
  return node.copy(Fragment.fromArray(joinText(children)));
}

function withLink(node: PMNode, attrs: OccurrenceAttrs): PMNode {
  if (node.type.name === "image") return withSource(node, attrs);
  if (!node.isText) return node;
  const old = node.marks.find((mark) => mark.type.name === "link");
  if (!old) return node;
  const mark = old.type.create({ ...old.attrs, ...attrs });
  return node.mark(mark.addToSet(old.removeFromSet(node.marks)));
}

function withSource(node: PMNode, attrs: OccurrenceAttrs): PMNode {
  return node.type.create(
    { ...node.attrs, src: attrs.href, ref: attrs.ref },
    node.content,
    node.marks,
  );
}

/** Adjacent text nodes with equal marks are one node in ProseMirror's normal form. */
function joinText(nodes: readonly PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last?.isText && node.isText && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = node.type.schema.text(
        `${last.text ?? ""}${node.text ?? ""}`,
        last.marks,
      );
      continue;
    }
    out.push(node);
  }
  return out;
}

function sameMarks(left: readonly Mark[], right: readonly Mark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark.eq(right[index] as Mark));
}

export function sameAttrs(left: OccurrenceAttrs, right: OccurrenceAttrs): boolean {
  return left.ref === right.ref && left.href === right.href && left.title === right.title;
}
