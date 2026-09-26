/** Defines registered editor object types and their behavior. */

import type { Node as PMNode } from "@tiptap/pm/model";

import { EDITOR_DIAGRAM_PROVIDERS } from "../diagrams/diagram-providers";

/** What Enter does on a selected object. */
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

/** What a press on the object's body does. */
export type ObjectBody = "text" | "block-drag" | "inline-drag";

/** Which control surface the node gets — the chip cluster and the row of verbs a lane renders over it. */
export type ObjectSurfaceKind = "diagram" | "image" | "code";

/** A document attribute the object's surface lets the writer edit, behind the ⋮. */
export type ObjectSurfaceField = "alt" | "caption" | "label";

export type ObjectTypeSpec = {
  /** This registration's stable identity — what a lane registers an engagement, a keymap, or a surface against. */
  id: string;
  /** Schema node name. */
  nodeType: string;
  /**
   * Narrows a node type that is only sometimes an object. A `code_block` is
   * prose the writer types into unless its language renders it as a diagram.
   */
  matches?: (node: PMNode) => boolean;
  body: ObjectBody;
  engage: ObjectEngageIntent;
  surfaceKind?: ObjectSurfaceKind;
  /** Attributes the object's ⋮ offers, in the order it offers them. */
  surfaceFields?: readonly ObjectSurfaceField[];
};

/** One row per fenced diagram dialect, generated so a new provider cannot ship without its physics. */
const DIAGRAM_OBJECT_TYPES: readonly ObjectTypeSpec[] = EDITOR_DIAGRAM_PROVIDERS.map(
  (provider) => ({
    id: `diagram:${provider.language}`,
    nodeType: "code_block",
    matches: (node: PMNode) => node.attrs.language === provider.language,
    // The rendered diagram is opaque; the source hatch it can open is a
    // control inside it, and a press on a control is never a press on a body.
    body: "block-drag",
    engage: "surface",
    surfaceKind: "diagram",
  }),
);

export const EDITOR_OBJECT_TYPES: readonly ObjectTypeSpec[] = [
  // ── kernel (M3) ──────────────────────────────────────────────────
  {
    id: "figure",
    nodeType: "figure",
    body: "block-drag",
    engage: "surface",
    surfaceKind: "image",
    // A figure shows a caption and a label under its picture, so both are verbs
    // on its surface; the node view only renders what they say.
    surfaceFields: ["alt", "caption", "label"],
  },
  {
    id: "image",
    nodeType: "image",
    body: "inline-drag",
    engage: "surface",
    surfaceKind: "image",
    surfaceFields: ["alt"],
  },
  { id: "table", nodeType: "table", body: "text", engage: "caret-inside" },
  { id: "rule", nodeType: "horizontal_rule", body: "block-drag", engage: "none" },
  ...DIAGRAM_OBJECT_TYPES,
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

/** What a press on this node's body does, and `text` for everything that is not a registered object — prose included. */
export function objectBody(node: PMNode): ObjectBody {
  return objectTypeSpec(node)?.body ?? "text";
}

/** Does this node's body stand in for text the page does not show? */
export function isOpaqueObject(node: PMNode): boolean {
  return objectBody(node) !== "text";
}

/** Which of its own attributes this node's surface offers as verbs, and none for everything else. */
export function objectSurfaceFields(node: PMNode): readonly ObjectSurfaceField[] {
  return objectTypeSpec(node)?.surfaceFields ?? [];
}

/** Which control surface this node gets, or null when it gets none. */
export function objectSurfaceKind(node: PMNode): ObjectSurfaceKind | null {
  const spec = objectTypeSpec(node);
  if (spec) return spec.surfaceKind ?? null;
  return isSourceBlock(node) ? "code" : null;
}

/** A block that holds text but is not prose — a code fence, an embedded component. */
export function isSourceBlock(node: PMNode): boolean {
  return node.type.spec.code === true;
}
