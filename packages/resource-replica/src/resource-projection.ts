/** Project visibility policy over account-global resources and installed catalogs. */
import { namespaceRepairDestination } from "./namespace-journal-policy";
import { intentOwnsDeletion, owningLocationIntent } from "./resource-intent-policy";
import {
  ownerOf,
  type ResourceCatalogCheckpoint,
  type ResourceLocation,
  type ResourceRecord,
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
  if (!failed || failed.desired.kind === "create" || failed.desired.kind === "set-folder-location")
    return null;
  return {
    intentId: failed.intentId,
    kind: failed.desired.kind,
    name:
      failed.desired.kind === "set-location"
        ? (namespaceRepairDestination(record.intents, failed)?.name ??
          failed.desired.destination.name)
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
    record.intents.some((intent) => intent.projectId === projectId && intentOwnsDeletion(intent))
  )
    return null;
  const placement = owningLocationIntent(
    projectId,
    record.intents,
    Boolean(record.resource.obligations.canonicalRefresh),
  )?.desired;
  if (placement?.kind === "set-location") {
    const folder = placement.destination.folderPath.split("/").filter(Boolean).join("/");
    return {
      scheme: placement.destination.scheme,
      path: `/${[folder, placement.destination.name].filter(Boolean).join("/")}`,
      name: placement.destination.name,
      ...ownerOf(placement.destination),
      provisional: false,
    };
  }
  const create = record.intents.find(
    (intent) => intent.projectId === projectId && intent.desired.kind === "create",
  )?.desired;
  // Refused filing returns a normal file to its accepted home, not a provisional reservation.
  const filed = record.intents.some(
    (intent) =>
      intent.desired.kind === "set-location" &&
      (intent.state === "settled" ||
        intent.state === "needs-repair" ||
        intent.state === "superseded"),
  );
  if (record.resource.canonical)
    return { ...record.resource.canonical, provisional: create?.kind === "create" && !filed };
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
    record.intents.some(
      (intent) =>
        intent.projectId === projectId &&
        intent.state !== "cancelled" &&
        intent.state !== "superseded",
    )
  )
    return true;
  return catalogDocumentIds(catalogs, projectId).has(record.resource.identity.documentId);
}

// Visibility runs once per record over the same checkpoint array, so the
// project's catalog files are indexed once per array instead of rescanned.
const catalogDocumentIndex = new WeakMap<
  readonly ResourceCatalogCheckpoint[],
  Map<string, ReadonlySet<string>>
>();

function catalogDocumentIds(
  catalogs: readonly ResourceCatalogCheckpoint[],
  projectId: string,
): ReadonlySet<string> {
  let byProject = catalogDocumentIndex.get(catalogs);
  if (!byProject) {
    byProject = new Map();
    catalogDocumentIndex.set(catalogs, byProject);
  }
  const cached = byProject.get(projectId);
  if (cached) return cached;
  const ids = new Set<string>();
  for (const catalog of catalogs) {
    if (catalog.projectId !== projectId) continue;
    for (const entry of catalog.entries) if (entry.kind === "file") ids.add(entry.entryId);
  }
  byProject.set(projectId, ids);
  return ids;
}
