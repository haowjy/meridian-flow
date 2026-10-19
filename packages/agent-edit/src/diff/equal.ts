/** Block-sequence equality for `has_effect` and `already_live`: whitespace and marks included, first difference wins. */
import type { Node as PMNode } from "prosemirror-model";

export function blocksEqual(a: readonly PMNode[], b: readonly PMNode[]): boolean {
  // An empty editor needs one ordinary paragraph; an empty fragment does not.
  if (a.length === 1 && a[0].type.name === "paragraph" && a[0].eq(a[0].type.create())) a = [];
  if (b.length === 1 && b[0].type.name === "paragraph" && b[0].eq(b[0].type.create())) b = [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !a[i].eq(b[i])) return false;
  return true;
}
