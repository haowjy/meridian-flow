import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { AllSelection, type EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";

import { selectedObject } from "../objects/object-selection";
import { isEditorObject, isSourceBlock, objectTypeSpec } from "../objects/object-types";

export const CHROME_CONTEXT_KINDS = [
  "document",
  "table",
  "table-cell",
  "source-block",
  "object",
] as const;

export type ChromeContextKind = (typeof CHROME_CONTEXT_KINDS)[number];

export type ChromeContext = {
  owner: ChromeContextKind;
  nodeType: string | null;
  objectSpec: string | null;
  pos: number | null;
  chain: readonly ChromeContextKind[];
  objectPos: number | null;
};

export const DOCUMENT_CHROME_CONTEXT: ChromeContext = {
  owner: "document",
  nodeType: null,
  objectSpec: null,
  pos: null,
  chain: ["document"],
  objectPos: null,
};

export function proseSelectionCovers(state: EditorState, pos: number | null): boolean {
  const { selection } = state;
  if (pos === null || selection.empty) return false;
  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return false;
  return pos >= selection.from && pos <= selection.to;
}

export function resolveChromeContext(state: EditorState): ChromeContext {
  const { selection } = state;

  const object = selectedObject(state);
  if (object) {
    const ancestors = resolveAncestors(state.doc.resolve(object.pos));
    return {
      owner: "object",
      nodeType: object.node.type.name,
      objectSpec: objectTypeSpec(object.node)?.id ?? null,
      pos: object.pos,
      chain: [...ancestors.chain, "object"],
      objectPos: ancestors.objectPos,
    };
  }

  const fence = selectedSourceBlock(state);
  if (fence) {
    const ancestors = resolveAncestors(state.doc.resolve(fence.pos));
    return {
      owner: "source-block",
      nodeType: fence.node.type.name,
      objectSpec: null,
      pos: fence.pos,
      chain: [...ancestors.chain, "source-block"],
      objectPos: ancestors.objectPos,
    };
  }

  const { chain, nodeType, pos, objectPos } = resolveAncestors(selection.$from);
  const owner = chain[chain.length - 1];
  return { owner, nodeType, objectSpec: null, pos, chain, objectPos };
}

export function selectedSourceBlock(state: EditorState): { node: PMNode; pos: number } | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  return isSourceBlock(selection.node) ? { node: selection.node, pos: selection.from } : null;
}

export function chromeContextAt(doc: PMNode, pos: number): ChromeContext {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);

  const node = doc.nodeAt(clamped);
  if (node && isEditorObject(node)) {
    const { chain, objectPos } = resolveAncestors($pos);
    return {
      owner: "object",
      nodeType: node.type.name,
      objectSpec: objectTypeSpec(node)?.id ?? null,
      pos: clamped,
      chain: [...chain, "object"],
      objectPos,
    };
  }

  const { chain, nodeType, pos: ownerPos, objectPos } = resolveAncestors($pos);
  return {
    owner: chain[chain.length - 1],
    nodeType,
    objectSpec: null,
    pos: ownerPos,
    chain,
    objectPos,
  };
}

type AncestorWalk = {
  chain: ChromeContextKind[];
  nodeType: string | null;
  pos: number | null;
  objectPos: number | null;
};

function resolveAncestors($pos: ResolvedPos): AncestorWalk {
  const walk: AncestorWalk = { chain: ["document"], nodeType: null, pos: null, objectPos: null };

  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
    if (isEditorObject(node)) walk.objectPos = $pos.before(depth);
    const kind = ancestorKind(node);
    if (!kind) continue;
    walk.chain.push(kind);
    walk.nodeType = node.type.name;
    walk.pos = $pos.before(depth);
  }

  return walk;
}

function ancestorKind(node: PMNode): ChromeContextKind | null {
  const role = node.type.spec.tableRole;
  if (role === "table") return "table";
  if (role === "cell" || role === "header_cell") return "table-cell";
  if (!isSourceBlock(node)) return null;

  return isEditorObject(node) ? "object" : "source-block";
}
