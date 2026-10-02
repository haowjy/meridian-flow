/** Canonical desktop Editor selection from route-local and persisted tab state. */

export function activeEditorDocumentId(
  localDocumentId: string | null | undefined,
  selectedTabId: string | null | undefined,
): string | undefined {
  return localDocumentId ?? selectedTabId ?? undefined;
}
