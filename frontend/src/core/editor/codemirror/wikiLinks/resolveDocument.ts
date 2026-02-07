import { useTreeStore } from "@/core/stores/useTreeStore";

/**
 * Resolve a wiki-link path to a document from tree store.
 * Tries exact path match first, then filename-only match only if unique.
 */
export function resolveDocumentByPath(path: string): {
  id: string;
  name: string;
  path: string;
  filename: string;
} | null {
  const documents = useTreeStore.getState().documents;

  const exactMatch = documents.find((d) => d.path === path);
  if (exactMatch) return exactMatch;

  const filename = path.split("/").pop();
  if (!filename) return null;

  const filenameMatches = documents.filter((d) => d.filename === filename);
  if (filenameMatches.length !== 1) return null;
  return filenameMatches[0] ?? null;
}

/**
 * Resolve document path from ID.
 */
export function resolveDocumentPathById(documentId: string): string | null {
  const doc = useTreeStore
    .getState()
    .documents.find((d) => d.id === documentId);
  return doc?.path ?? null;
}
