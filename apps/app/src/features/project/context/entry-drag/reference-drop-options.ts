/**
 * What a writing surface says about project-tree rows dropped on it: which
 * drag is live, how a row becomes the surface's own chip, and the three labels
 * by the pointer. The editor and the composer build their reference door from
 * this one function, so a row means the same thing in both.
 */
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import type { ReferenceDropOptions } from "@/core/editor/extensions/reference-drop";

import { clearDragHint, showDragHint } from "../tree-drop/drag-hint";
import { activeDragSession } from "./drag-session";

export function referenceDropOptions({
  catalog,
  labels,
}: {
  /** Read at drag time, so a catalog that loads later is picked up. */
  catalog: () => Pick<AtReferenceCatalog, "resolveReference" | "referenceNode"> | null;
  labels: { accept: string; unavailable: string; code: string };
}): ReferenceDropOptions {
  return {
    activeDrag: () => activeDragSession()?.entries ?? null,
    content: (schema, entries) => {
      const host = catalog();
      if (!host) return null;
      const nodes = entries.map((entry) => {
        const row = host.resolveReference(entry.ref);
        return row ? host.referenceNode(schema, row) : null;
      });
      return nodes.every((node) => node !== null) ? nodes : null;
    },
    label: (kind) => labels[kind],
    showHint: showDragHint,
    clearHint: clearDragHint,
  };
}
