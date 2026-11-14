/** Block-sequence equality for `has_effect` and `already_live`: whitespace and marks included, first difference wins. */
import { isEmptyDocument } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";

export function blocksEqual(a: readonly PMNode[], b: readonly PMNode[]): boolean {
  if (isEmptyDocument(a)) a = [];
  if (isEmptyDocument(b)) b = [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !a[i].eq(b[i])) return false;
  return true;
}
