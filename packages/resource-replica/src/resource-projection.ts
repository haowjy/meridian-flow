/** Project visibility policy over account-global resources and installed catalogs. */
import type { ResourceCatalogCheckpoint, ResourceRecord } from "./resource-records";

export function resourceVisibleInProject(
  projectId: string,
  record: ResourceRecord,
  catalogs: readonly ResourceCatalogCheckpoint[],
): boolean {
  if (
    record.intents.some((intent) => intent.projectId === projectId && intent.state !== "cancelled")
  )
    return true;
  const documentId = record.resource.identity.documentId;
  return catalogs.some(
    (catalog) =>
      catalog.projectId === projectId &&
      !catalog.invalidatedEntryIds.includes(documentId) &&
      catalog.entries.some((entry) => entry.kind === "file" && entry.entryId === documentId),
  );
}
