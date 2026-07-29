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
 * What the pointer finds inside the object (§5.8).
 *
 * An `opaque` body has nothing to select and nothing to type into — a picture,
 * a rule, a rendered diagram — so a press on it is a press on the object, and
 * the body can be a second door into the same block drag the margin handle
 * starts. A `text` body already owns its pointer: a table's cells take
 * drag-selection across them, and a grab that moved the whole table instead
 * would take that away.
 */
export type ObjectBody = "opaque" | "text";

export type ObjectTypeSpec = {
  /** Schema node name. */
  nodeType: string;
  /**
   * Narrows a node type that is only sometimes an object. A `code_block` is
   * prose the writer types into unless its language renders it as a diagram.
   */
  matches?: (node: PMNode) => boolean;
  body: ObjectBody;
  engage: ObjectEngageIntent;
};

export const EDITOR_OBJECT_TYPES: readonly ObjectTypeSpec[] = [
  // ── kernel (M3) ──────────────────────────────────────────────────
  { nodeType: "figure", body: "opaque", engage: "surface" },
  { nodeType: "image", body: "opaque", engage: "surface" },
  { nodeType: "table", body: "text", engage: "caret-inside" },
  { nodeType: "horizontal_rule", body: "opaque", engage: "none" },
  {
    // Mermaid is not a node (§8): rendering keys off the language attr, so
    // object physics has to as well. A plain fence stays prose you type in.
    nodeType: "code_block",
    matches: (node) => node.attrs.language === "mermaid",
    // The rendered diagram is opaque; the source hatch it can open is a
    // control inside it, and a press on a control is never a press on a body.
    body: "opaque",
    engage: "surface",
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
 * True when a press on this node's body may start the block drag its margin
 * handle starts (§5.8). The registration answers it — nothing about a picture
 * in the schema says the writer can grab it.
 */
export function isObjectBodyDragSource(node: PMNode): boolean {
  return objectTypeSpec(node)?.body === "opaque";
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
