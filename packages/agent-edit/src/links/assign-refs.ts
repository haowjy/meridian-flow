/**
 * Binding written link and source attrs to stored ones, after parse.
 *
 * Parse is pure syntax; everything that needs the document tree happens here,
 * over a prepared holder scope. Today that is the shipped image rule; lane A1
 * adds ref assignment for links beside it.
 */
import type { PMNode } from "@meridian/markup";
import { Fragment } from "prosemirror-model";
import { type HolderLinkScope, writtenSourceUri } from "../ports/document-links.js";

/**
 * The shipped image rule: a written `image`/`figure` source naming a picture
 * the project knows becomes `asset:<id>`, so the reference survives moves. A
 * source the scope cannot claim stays as written; guessing an id would store
 * a reference that can never render.
 */
export function bindSources(
  blocks: readonly PMNode[],
  scope: Pick<HolderLinkScope, "assetFor">,
): PMNode[] {
  return blocks.map((block) => bindNode(block, scope));
}

function bindNode(node: PMNode, scope: Pick<HolderLinkScope, "assetFor">): PMNode {
  if (node.type.name === "image" || node.type.name === "figure") {
    const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
    const uri = writtenSourceUri(src);
    const assetId = uri ? scope.assetFor(uri) : null;
    if (!assetId) return node;
    return node.type.create(
      { ...node.attrs, src: `asset:${assetId}`, ref: null },
      node.content,
      node.marks,
    );
  }
  if (node.isLeaf) return node;
  let changed = false;
  const children: PMNode[] = [];
  node.forEach((child) => {
    const bound = bindNode(child, scope);
    if (bound !== child) changed = true;
    children.push(bound);
  });
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}
