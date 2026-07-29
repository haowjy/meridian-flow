/**
 * Which nodes are objects, and what Enter does to each.
 *
 * The design's second register (§1): nodes the writer selects rather than
 * types into, usually machine-written. Object-ness is a registration, never a
 * structural guess — ProseMirror's own categories cannot tell a figure from a
 * blockquote, and a diagram fence is a `code_block` whose attrs decide.
 *
 * **This table is an append-only seam.** A lane that ships a new object type
 * adds one row here and nothing else: selection, arrow-walk, Esc, the greying
 * context, and every control surface read it. Fenced diagrams do not even need
 * a row of their own — theirs are generated from the diagram-provider catalog
 * (`../diagrams/diagram-providers.ts`), so a new diagram kind is one provider
 * row plus its renderer.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

import { EDITOR_DIAGRAM_PROVIDERS } from "../diagrams/diagram-providers";

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
 * What a press on the object's body does (§5.8).
 *
 * ONE column, because caret-landing and drag-start are the same fact told
 * twice: a body that shows its own text takes a caret and starts no drag, and a
 * body standing in for text the page does not show refuses the caret and IS the
 * grip. A caret in DOM the writer cannot see eats every keystroke it is given
 * (`../pointer-boundary.ts` keeps that rule), and a body with nothing to type
 * into is what a writer reaches for when they mean to move the thing itself.
 *
 * - **`text`** shows its text and takes a caret like prose, and a grab sweeps a
 *   selection across it rather than picking it up: a table's cells.
 * - **`block-drag`** is opaque, and the drag it starts is the margin handle's —
 *   the object's top-level block travels to a seam between blocks, behind the
 *   jade drop line. A figure, a rule, a rendered diagram.
 * - **`inline-drag`** is opaque, and leaves the press to ProseMirror's own drag,
 *   which carries the node as an inline slice and lands it anywhere a caret can
 *   go: between two words, with the dropcursor drawing the caret there (human
 *   ruling, 2026-07-29: a picture drags in between text). Only a node the schema
 *   calls inline can answer this, and its node view has to carry
 *   `data-drag-handle` or TipTap refuses the browser's dragstart.
 *
 * Splitting this back into two columns takes a real object that wants a
 * combination it cannot say: a body that shows its text and is still a grip, or
 * an opaque body that starts no drag. Every row here satisfies
 * `opaque === (body !== "text")`, and a second column for that is one more
 * state a row can get wrong (tech-lead ruling, 2026-07-29).
 */
export type ObjectBody = "text" | "block-drag" | "inline-drag";

/**
 * Which control surface the node gets — the chip cluster and the row of verbs
 * a lane renders over it.
 *
 * Not the same question as object-ness, which is why it is optional here and
 * why one kind has no row at all: a plain code fence is prose the writer types
 * into and still carries the code chips, while a rendered diagram fence is the
 * same node type wearing the diagram's face. An object with no `surfaceKind`
 * (a table, a rule) gets no cluster.
 */
export type ObjectSurfaceKind = "diagram" | "image" | "code";

/**
 * A document attribute the object's surface lets the writer edit, behind the ⋮
 * (§5.6: alt text edits in a small popover).
 *
 * The registration says which fields an object has, so one image surface serves
 * the inline picture and the captioned figure without asking which node it is
 * looking at. Each name is an attribute on the node.
 */
export type ObjectSurfaceField = "alt" | "caption" | "label";

export type ObjectTypeSpec = {
  /**
   * This registration's stable identity — what a lane registers an engagement,
   * a keymap, or a surface against.
   *
   * Not the node type: one node type carries several registrations (every
   * fenced diagram dialect is a `code_block`), and keying by the type would let
   * the second dialect overwrite the first's surface.
   */
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

/**
 * One row per fenced diagram dialect, generated so a new provider cannot ship
 * without its physics. Mermaid is not a node (§8): rendering keys off the
 * language attr, so object physics has to as well, and a fence in a language no
 * provider claims stays prose you type in.
 */
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

/**
 * What a press on this node's body does, and `text` for everything that is not
 * a registered object — prose included.
 *
 * The registration answers it. A rendered diagram is a `code_block` and a figure
 * is not a blockquote by anything ProseMirror can see; nothing in the schema
 * says a picture can be grabbed, and nothing about a figure says the block seam
 * is the only place it can land. All of it is design, and all of it is this one
 * column — which is why no caller may guess it from a node name or a schema flag.
 */
export function objectBody(node: PMNode): ObjectBody {
  return objectTypeSpec(node)?.body ?? "text";
}

/**
 * Which of its own attributes this node's surface offers as verbs, and none for
 * everything else (§5.6).
 *
 * The registration answers, which is what lets one image surface serve the inline
 * picture and the captioned figure: the picture has alt text, the figure adds the
 * caption and label it shows under itself.
 */
export function objectSurfaceFields(node: PMNode): readonly ObjectSurfaceField[] {
  return objectTypeSpec(node)?.surfaceFields ?? [];
}

/**
 * Which control surface this node gets, or null when it gets none (§5.2).
 *
 * The registration answers for every object. The one node that carries a
 * cluster without being an object is the plain code fence — the same
 * `code_block` a diagram row claims when its language renders, which is why the
 * exception is named here rather than re-derived beside each surface.
 */
export function objectSurfaceKind(node: PMNode): ObjectSurfaceKind | null {
  const spec = objectTypeSpec(node);
  if (spec) return spec.surfaceKind ?? null;
  return isSourceBlock(node) ? "code" : null;
}

/**
 * A block that holds text but is not prose — a code fence, an embedded
 * component. ProseMirror calls both text blocks; the schema's own `code` flag
 * is what separates them, and classifying by `isTextblock` is what once let a
 * select-all flatten a diagram fence (see `surfaces/toolbar`).
 *
 * A node can be both a source block and an object: an unrendered diagram fence
 * is a code block with a caret in it, and a rendered one is a diagram. The
 * object registration wins where both apply.
 */
export function isSourceBlock(node: PMNode): boolean {
  return node.type.spec.code === true;
}
