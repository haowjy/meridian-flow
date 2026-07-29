/**
 * Deepest-context resolution: which context owns chrome right now.
 *
 * Law 4 makes the deepest context under the selection the owner of any
 * transient surface — cell text beats table, table beats document. One
 * resolver answers that question for everybody: the Esc chain walks home
 * through it, the context-menu router routes by it, and the persistent
 * toolbar greys by it. A second reading of the document would be a second
 * answer, and two answers is how a surface ends up owned by nobody.
 *
 * Pure over `EditorState`; nothing here touches the DOM or React.
 */

import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

import { selectedObject } from "../objects/object-selection";
import { isEditorObject, isSourceBlock } from "../objects/object-types";

/**
 * The contexts chrome can be owned by, shallowest first. The order is the
 * nesting order, not a precedence list: `chain` reports what the selection is
 * standing inside and `owner` is the last (deepest) of them.
 */
export const CHROME_CONTEXT_KINDS = [
  "document",
  "table",
  "table-cell",
  "source-block",
  "object",
] as const;

export type ChromeContextKind = (typeof CHROME_CONTEXT_KINDS)[number];

export type ChromeContext = {
  /** The deepest context under the selection: the owner of transient chrome. */
  owner: ChromeContextKind;
  /** Owner node's schema type name. Null only at the document level. */
  nodeType: string | null;
  /** Owner node's document position. Null only at the document level. */
  pos: number | null;
  /** Document down to the owner, deepest last; `chain.at(-1) === owner`. */
  chain: readonly ChromeContextKind[];
};

export const DOCUMENT_CHROME_CONTEXT: ChromeContext = {
  owner: "document",
  nodeType: null,
  pos: null,
  chain: ["document"],
};

export function resolveChromeContext(state: EditorState): ChromeContext {
  const { selection } = state;

  // A selected object names its owner outright, whatever it is nested in. The
  // ancestor walk still runs so a selected table cell's table shows in the
  // chain: surfaces read the chain to know what else is above them.
  const object = selectedObject(state);
  if (object) {
    const ancestors = resolveAncestors(state.doc.resolve(object.pos));
    return {
      owner: "object",
      nodeType: object.node.type.name,
      pos: object.pos,
      chain: [...ancestors.chain, "object"],
    };
  }

  const { chain, nodeType, pos } = resolveAncestors(selection.$from);
  const owner = chain[chain.length - 1];
  return { owner, nodeType, pos, chain };
}

/**
 * The context at an arbitrary document position — what the POINTER is over,
 * as opposed to what the selection is in. The context-menu router needs this
 * one: a right-click is aimed at a place, and the selection may be elsewhere.
 */
export function chromeContextAt(doc: PMNode, pos: number): ChromeContext {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);

  const node = doc.nodeAt(clamped);
  if (node && isEditorObject(node)) {
    const { chain } = resolveAncestors($pos);
    return {
      owner: "object",
      nodeType: node.type.name,
      pos: clamped,
      chain: [...chain, "object"],
    };
  }

  const { chain, nodeType, pos: ownerPos } = resolveAncestors($pos);
  return { owner: chain[chain.length - 1], nodeType, pos: ownerPos, chain };
}

type AncestorWalk = {
  chain: ChromeContextKind[];
  nodeType: string | null;
  pos: number | null;
};

function resolveAncestors($pos: ResolvedPos): AncestorWalk {
  const walk: AncestorWalk = { chain: ["document"], nodeType: null, pos: null };

  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
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

  // A rendered mermaid fence has no inside to point at: the pointer is over a
  // diagram, so the diagram owns the point. A table is an object too, but its
  // cells ARE prose (§5.4), so it keeps its own chain and this never applies.
  return isEditorObject(node) ? "object" : "source-block";
}
