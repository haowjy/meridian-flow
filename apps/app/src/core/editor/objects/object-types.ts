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
  /** Nothing to engage; Enter falls through. */
  | "none";

export type ObjectTypeSpec = {
  /** Schema node name. */
  nodeType: string;
  /**
   * Narrows a node type that is only sometimes an object. A `code_block` is
   * prose the writer types into unless its language renders it as a diagram.
   */
  matches?: (node: PMNode) => boolean;
  engage: ObjectEngageIntent;
};

export const EDITOR_OBJECT_TYPES: readonly ObjectTypeSpec[] = [
  // ── kernel (M3) ──────────────────────────────────────────────────
  { nodeType: "figure", engage: "surface" },
  { nodeType: "image", engage: "surface" },
  { nodeType: "table", engage: "caret-inside" },
  { nodeType: "horizontal_rule", engage: "none" },
  {
    // Mermaid is not a node (§8): rendering keys off the language attr, so
    // object physics has to as well. A plain fence stays prose you type in.
    nodeType: "code_block",
    matches: (node) => node.attrs.language === "mermaid",
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
