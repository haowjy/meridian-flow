import { useCallback, useMemo } from "react";

import { getDescendantDocumentIds } from "@/core/lib/treeUtils";
import { useTreeStore } from "@/core/stores/useTreeStore";
import type { Document } from "@/features/documents/types/document";
import type { ReferenceElementData } from "@/features/threads/composer/inlineElements";

import {
  rankReferenceItems,
  type ReferenceSearchItem,
} from "./documentReferenceSearch";

function buildReferencesForItem(
  item: ReferenceSearchItem,
  documents: Document[],
  tree: ReturnType<typeof useTreeStore.getState>["tree"],
): ReferenceElementData[] {
  if (item.refType === "document") {
    const doc = documents.find((d) => d.id === item.id);
    if (!doc) return [];
    return [
      {
        type: "reference",
        documentId: doc.id,
        refType: "document",
        displayName: doc.name,
        documentPath: doc.path,
      },
    ];
  }

  const descendantIds = getDescendantDocumentIds(tree, item.id);
  if (descendantIds.length === 0) return [];

  const docMap = new Map(documents.map((d) => [d.id, d]));
  return descendantIds
    .map((id) => docMap.get(id))
    .filter((doc): doc is Document => doc !== undefined)
    .map((doc) => ({
      type: "reference" as const,
      documentId: doc.id,
      refType: "document",
      displayName: doc.name,
      documentPath: doc.path,
    }));
}

export function useDocumentReferenceSelector(query: string) {
  const documents = useTreeStore((s) => s.documents);
  const folders = useTreeStore((s) => s.folders);
  const tree = useTreeStore((s) => s.tree);

  const items = useMemo(
    () => rankReferenceItems(query.trim(), documents, folders),
    [query, documents, folders],
  );

  const getReferencesForItem = useCallback(
    (item: ReferenceSearchItem) => buildReferencesForItem(item, documents, tree),
    [documents, tree],
  );

  return {
    items,
    documentsCount: documents.length,
    getReferencesForItem,
  };
}

