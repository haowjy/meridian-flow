import type { Node as PMNode } from "@tiptap/pm/model";

import { EDITOR_DIAGRAM_PROVIDERS } from "../diagrams/diagram-providers";
import { pictureCapped } from "./picture-cap";

export type ObjectEngageIntent =
  | "surface"
  | "caret-inside"
  /**
   * Nothing to engage. Enter is still consumed — a selected object never
   * lets the key reach the base keymap, which would split the block around it.
   */
  | "none";

export type ObjectBody = "text" | "block-drag" | "inline-drag";

export type ObjectSurfaceKind = "diagram" | "image" | "code";

export type ObjectSurfaceField = "alt" | "caption" | "label";

export type ObjectTypeSpec = {
  id: string;
  nodeType: string;
  matches?: (node: PMNode) => boolean;
  body: ObjectBody;
  engage: ObjectEngageIntent;
  surfaceKind?: ObjectSurfaceKind;
  clickEngages?: (target: EventTarget | null) => boolean;
  surfaceFields?: readonly ObjectSurfaceField[];
};

const DIAGRAM_OBJECT_TYPES: readonly ObjectTypeSpec[] = EDITOR_DIAGRAM_PROVIDERS.map(
  (provider) => ({
    id: `diagram:${provider.language}`,
    nodeType: "code_block",
    matches: (node: PMNode) => node.attrs.language === provider.language,
    body: "block-drag",
    engage: "surface",
    surfaceKind: "diagram",
  }),
);

export const EDITOR_OBJECT_TYPES: readonly ObjectTypeSpec[] = [
  {
    id: "figure",
    nodeType: "figure",
    body: "block-drag",
    engage: "surface",
    surfaceKind: "image",
    clickEngages: pictureCapped,
    surfaceFields: ["alt", "caption", "label"],
  },
  {
    id: "image",
    nodeType: "image",
    body: "inline-drag",
    engage: "surface",
    surfaceKind: "image",
    clickEngages: pictureCapped,
    surfaceFields: ["alt"],
  },
  { id: "table", nodeType: "table", body: "text", engage: "caret-inside" },
  { id: "rule", nodeType: "horizontal_rule", body: "block-drag", engage: "none" },
  ...DIAGRAM_OBJECT_TYPES,
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

export function objectBody(node: PMNode): ObjectBody {
  return objectTypeSpec(node)?.body ?? "text";
}

export function isOpaqueObject(node: PMNode): boolean {
  return objectBody(node) !== "text";
}

export function objectSurfaceFields(node: PMNode): readonly ObjectSurfaceField[] {
  return objectTypeSpec(node)?.surfaceFields ?? [];
}

export function objectSurfaceKind(node: PMNode): ObjectSurfaceKind | null {
  const spec = objectTypeSpec(node);
  if (spec) return spec.surfaceKind ?? null;
  return isSourceBlock(node) ? "code" : null;
}

export function isSourceBlock(node: PMNode): boolean {
  return node.type.spec.code === true;
}

export function isCodeBlock(node: PMNode): boolean {
  return node.type.name === "code_block";
}

export function isObjectLike(node: PMNode): boolean {
  return node.isLeaf || isOpaqueObject(node) || isSourceBlock(node);
}
