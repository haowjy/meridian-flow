/** Project visibility policy over account-global resources and installed catalogs. */
import type {
  ResourceCatalogCheckpoint,
  ResourceLocation,
  ResourceRecord,
} from "./resource-records";

export type ProjectResourceLocation = ResourceLocation & { provisional: boolean };

/** Current identities outrank obsolete remint aliases when both exist in the account catalog. */
export function resourceForDocumentIdentity(
  records: readonly ResourceRecord[],
  documentId: string,
): ResourceRecord | null {
  const current = records.filter(({ resource }) => resource.identity.documentId === documentId);
  if (current.length > 1) throw new Error("Document identity resolves to multiple resources");
  if (current[0]) return current[0];
  const aliases = records.filter(({ resource }) => documentId in resource.aliases);
  if (aliases.length > 1) throw new Error("Document alias resolves to multiple resources");
  return aliases[0] ?? null;
}

export function projectResourceNeedsRepair(
  projectId: string,
  record: ResourceRecord,
): { intentId: string; kind: "set-location" | "delete"; name: string } | null {
  const failed = record.intents.find(
    (intent) => intent.projectId === projectId && intent.state === "needs-repair",
  );
  if (!failed || failed.desired.kind === "create") return null;
  return {
    intentId: failed.intentId,
    kind: failed.desired.kind,
    name:
      failed.desired.kind === "set-location"
        ? failed.desired.destination.name
        : (record.resource.canonical?.name ?? "document"),
  };
}

/** Writer-facing location, including durable local intentions not yet reflected by a catalog. */
export function projectResourceLocation(
  projectId: string,
  record: ResourceRecord,
): ProjectResourceLocation | null {
  if (
    record.resource.lifecycle.kind === "terminal" ||
    record.intents.some(
      (intent) =>
        intent.projectId === projectId &&
        intent.desired.kind === "delete" &&
        intent.state !== "cancelled" &&
        intent.state !== "needs-repair",
    )
  )
    return null;
  const placement = [...record.intents]
    .sort((left, right) => right.sequence - left.sequence)
    .find(
      (intent) =>
        intent.projectId === projectId &&
        intent.desired.kind === "set-location" &&
        intent.state !== "cancelled" &&
        intent.state !== "settled-locally" &&
        intent.state !== "needs-repair",
    )?.desired;
  if (placement?.kind === "set-location") {
    const folder = placement.destination.folderPath.split("/").filter(Boolean).join("/");
    return {
      scheme: placement.destination.scheme,
      path: `/${[folder, placement.destination.name].filter(Boolean).join("/")}`,
      name: placement.destination.name,
      workId: placement.destination.workId,
      ...(placement.destination.workSlug ? { workSlug: placement.destination.workSlug } : {}),
      provisional: false,
    };
  }
  const create = record.intents.find(
    (intent) => intent.projectId === projectId && intent.desired.kind === "create",
  )?.desired;
  if (record.resource.canonical)
    return { ...record.resource.canonical, provisional: create?.kind === "create" };
  if (create?.kind !== "create") return null;
  const folder = create.folderPath.split("/").filter(Boolean).join("/");
  const name = create.provisionalName ?? "Untitled";
  return {
    scheme: "unfiled",
    path: `/${[folder, name].filter(Boolean).join("/")}`,
    name,
    workId: null,
    provisional: true,
  };
}

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
