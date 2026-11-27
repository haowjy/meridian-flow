import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import type { ReferenceDropOptions } from "@/core/editor/extensions/reference-drop";

import { entryDragOf } from "./drag-session";

export function referenceDropOptions({
  catalog,
  labels,
}: {
  catalog: () => Pick<AtReferenceCatalog, "resolveReference" | "referenceNode"> | null;
  labels: { accept: string; unavailable: string; code: string };
}): ReferenceDropOptions {
  return {
    draggedEntries: (event) => entryDragOf(event)?.entries ?? null,
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
  };
}
