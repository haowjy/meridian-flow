/**
 * Inline review model: the browser-computed review the extension paints.
 *
 * `ProjectedReview` is `projectReview`'s output plus the two things a client needs to act on it: the
 * editor document its positions belong to, and the `Y.Snapshot` of the draft room it was computed at
 * (Apply sends the snapshot so the server rebuilds exactly what the writer saw). Kept free of
 * ProseMirror view imports so it unit-tests without a DOM.
 */
import type { ProseMirrorJSON, ReviewProjection } from "@meridian/agent-edit/diff";
import type { Node as PMNode } from "@tiptap/pm/model";
import type * as Y from "yjs";

/**
 * One review frame: `projectReview`'s output with what an action on it needs. It is immutable, and every
 * row or command made from it carries it, so a click always means the change that was drawn.
 */
export interface ProjectedReview extends ReviewProjection {
  /** The editor document `inserted` and `anchor` positions address; a projection of another doc is stale. */
  doc: PMNode;
  snapshot: Y.Snapshot;
}

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether two documents hold the same content at the same positions. `Node.eq` cannot answer it across
 * editors: each editor builds its own schema, so equal text has different node types. Compares type names,
 * attributes, marks and text, exiting at the first difference.
 */
export function sameContent(a: PMNode, b: PMNode): boolean {
  if (a === b) return true;
  if (a.type.name !== b.type.name || a.childCount !== b.childCount || a.nodeSize !== b.nodeSize)
    return false;
  if (a.isText) return a.text === b.text && sameMarks(a, b);
  if (!sameJson(a.attrs, b.attrs) || !sameMarks(a, b)) return false;
  for (let i = 0; i < a.childCount; i++) if (!sameContent(a.child(i), b.child(i))) return false;
  return true;
}

const sameMarks = (a: PMNode, b: PMNode) =>
  a.marks.length === b.marks.length &&
  a.marks.every(
    (mark, i) => mark.type.name === b.marks[i].type.name && sameJson(mark.attrs, b.marks[i].attrs),
  );

/**
 * The review carried through the writer's edit: every position the painter and the scroll read
 * (`inserted`, `anchor`) moves with the text, and the review now addresses `doc`.
 */
export function mapReview(
  review: ProjectedReview,
  mapping: { map(position: number, assoc?: number): number },
  doc: PMNode,
): ProjectedReview {
  return {
    ...review,
    doc,
    groups: review.groups.map((group) => ({
      ...group,
      hunks: group.hunks.map((hunk) => ({
        ...hunk,
        anchor: mapping.map(hunk.anchor, -1),
        ...(hunk.formatContext && {
          formatContext: {
            ...hunk.formatContext,
            inserted: hunk.formatContext.inserted.map(({ from, to }) => ({
              from: mapping.map(from, 1),
              to: mapping.map(to, -1),
            })),
          },
        }),
        inserted: hunk.inserted
          ? { from: mapping.map(hunk.inserted.from, 1), to: mapping.map(hunk.inserted.to, -1) }
          : null,
      })),
    })),
  };
}

/**
 * The paragraphs of text a hunk removed. Inline removals come back as one entry; block removals as one
 * per block, each without its leading space. Marks are dropped: a removal is red, whatever it was.
 */
export function removedParagraphs(removed: readonly ProseMirrorJSON[]): string[] {
  const out: string[] = [];
  const collect = (node: ProseMirrorJSON): string | null => {
    if (node.type === "text") return node.text ?? "";
    if (!node.content?.length) return null;
    const children = node.content as ProseMirrorJSON[];
    if (children.every((child) => child.type === "text" || !child.content)) {
      return children.map((child) => (child.type === "text" ? (child.text ?? "") : " ")).join("");
    }
    for (const child of children) {
      const text = collect(child);
      if (text !== null) out.push(text);
    }
    return null;
  };
  // Leading inline content (a removal that starts mid-block) is one paragraph before the blocks.
  let inline = "";
  const flush = () => {
    if (inline) out.push(inline);
    inline = "";
  };
  for (const node of removed) {
    if (node.type === "text") {
      inline += node.text ?? "";
      continue;
    }
    flush();
    const text = collect(node);
    if (text !== null) out.push(text);
  }
  flush();
  // A token carries the space before it; the widget starts at the word.
  return out.map((paragraph) => paragraph.trimStart()).filter((paragraph) => paragraph !== "");
}
