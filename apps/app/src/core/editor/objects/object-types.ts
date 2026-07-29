/**
 * Which nodes are objects, and what Enter does to each.
 *
 * The design's second register (§1): nodes the writer selects rather than
 * types into, usually machine-written. Object-ness is a registration, never a
 * structural guess — ProseMirror's own categories cannot tell a figure from a
 * blockquote, and a mermaid fence is a `code_block` whose attrs decide.
 *
 * **This table is an append-only seam.** A lane that ships a new object type
 * adds one row here and nothing else: selection, arrow-walk, Esc, and the
 * greying context all read it.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * What Enter does on a selected object (§4). `surface` needs React, so the
 * owning lane registers a handler with `registerObjectEngagement`; the other
 * two are document operations the kernel performs itself.
 */
export type ObjectEngageIntent =
  /** Open the object's own surface — the diagram/image dialog. */
  | "surface"
  /** Drop the caret at the first text position inside (a table's first cell). */
  | "caret-inside"
  /**
   * Nothing to engage. Enter is still consumed — a selected object never
   * lets the key reach the base keymap, which would split the block around it.
   */
  | "none";

/**
 * Which drag a press on the object's body starts (§5.8).
 *
 * A body with nothing to select and nothing to type into — a picture, a rule,
 * a rendered diagram — is a door into a drag, because taking hold of the thing
 * itself is what a writer reaches for first. WHICH drag is the object's own
 * shape:
 *
 * - **`block`** starts the drag the margin handle starts: the object's
 *   top-level block travels to a seam between blocks, behind the jade drop
 *   line. A figure is a block and has nowhere else to land.
 * - **`inline`** leaves the press to ProseMirror's own drag, which carries the
 *   node as an inline slice and lands it anywhere a caret can go — between two
 *   words of a sentence, with the dropcursor showing where (human ruling,
 *   2026-07-29: images drag in between text). Only a node the schema calls
 *   inline can answer this.
 * - **`none`** is a body that already owns its pointer: a table's cells take
 *   the drag-selection sweeping across them, and a grab that moved the whole
 *   table instead would take that away.
 */
export type ObjectDrag = "block" | "inline" | "none";

/**
 * Which control surface the node gets — the chip cluster and the row of verbs
 * a lane renders over it.
 *
 * Not the same question as object-ness, which is why it is optional here and
 * why one kind has no row at all: a plain code fence is prose the writer types
 * into and still carries the code chips, while a rendered mermaid fence is the
 * same node type wearing the diagram's face. An object with no `surfaceKind`
 * (a table, a rule) gets no cluster.
 */
export type ObjectSurfaceKind = "diagram" | "image" | "code";

export type ObjectTypeSpec = {
  /** Schema node name. */
  nodeType: string;
  /**
   * Narrows a node type that is only sometimes an object. A `code_block` is
   * prose the writer types into unless its language renders it as a diagram.
   */
  matches?: (node: PMNode) => boolean;
  drag: ObjectDrag;
  engage: ObjectEngageIntent;
  surfaceKind?: ObjectSurfaceKind;
};

export const EDITOR_OBJECT_TYPES: readonly ObjectTypeSpec[] = [
  // ── kernel (M3) ──────────────────────────────────────────────────
  { nodeType: "figure", drag: "block", engage: "surface", surfaceKind: "image" },
  { nodeType: "image", drag: "inline", engage: "surface", surfaceKind: "image" },
  { nodeType: "table", drag: "none", engage: "caret-inside" },
  { nodeType: "horizontal_rule", drag: "block", engage: "none" },
  {
    // Mermaid is not a node (§8): rendering keys off the language attr, so
    // object physics has to as well. A plain fence stays prose you type in.
    nodeType: "code_block",
    matches: (node) => node.attrs.language === "mermaid",
    // The rendered diagram is opaque; the source hatch it can open is a
    // control inside it, and a press on a control is never a press on a body.
    drag: "block",
    engage: "surface",
    surfaceKind: "diagram",
  },
  // ── surface lanes append one row per object type below ───────────
];

export function objectTypeSpec(node: PMNode): ObjectTypeSpec | null {
  for (const spec of EDITOR_OBJECT_TYPES) {
    if (spec.nodeType !== node.type.name) continue;
    if (spec.matches && !spec.matches(node)) continue;
    return spec;
  }
  return null;
}

export function isEditorObject(node: PMNode): boolean {
  return objectTypeSpec(node) !== null;
}

/**
 * Which drag a press on this node's body starts (§5.8), and `none` for
 * everything that is not a drag source — prose included.
 *
 * The registration answers it. Nothing about a picture in the schema says the
 * writer can grab it, and nothing about a figure says the block seam is the
 * only place it can land; both are design, and both are this column.
 */
export function objectDrag(node: PMNode): ObjectDrag {
  return objectTypeSpec(node)?.drag ?? "none";
}

/**
 * Which control surface this node gets, or null when it gets none (§5.2).
 *
 * The registration answers for every object. The one node that carries a
 * cluster without being an object is the plain code fence — the same
 * `code_block` the mermaid row claims when its language renders, which is why
 * the exception is named here rather than re-derived beside each surface.
 */
export function objectSurfaceKind(node: PMNode): ObjectSurfaceKind | null {
  const spec = objectTypeSpec(node);
  if (spec) return spec.surfaceKind ?? null;
  return node.type.name === "code_block" ? "code" : null;
}

/**
 * A block that holds text but is not prose — a code fence, an embedded
 * component. ProseMirror calls both text blocks; the schema's own `code` flag
 * is what separates them, and classifying by `isTextblock` is what once let a
 * select-all flatten a mermaid fence (see `surfaces/toolbar`).
 *
 * A node can be both a source block and an object: an unrendered mermaid fence
 * is a code block with a caret in it, and a rendered one is a diagram. The
 * object registration wins where both apply.
 */
export function isSourceBlock(node: PMNode): boolean {
  return node.type.spec.code === true;
}
