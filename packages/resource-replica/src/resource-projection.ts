/** Project visibility policy over account-global resources and installed catalogs. */
import { namespaceRepairDestination } from "./namespace-journal-policy";
import {
  awaitsWriterRepair,
  intentOwnsDeletionAt,
  placementDestination,
} from "./resource-intent-policy";
import {
  type DestinationParentLookup,
  destinationLocation,
  type ResourceCatalogCheckpoint,
  type ResourceDestination,
  type ResourceLocation,
  type ResourceRecord,
} from "./resource-records";

export type ProjectResourceLocation = ResourceLocation & { provisional: boolean };

/** One projection's identity lookup: by stable handle, or by document id with its alias rule. */
export type ResourceIdentityIndex = {
  byHandle(handle: string): ResourceRecord | null;
  /** A current identity outranks another resource's obsolete remint alias. */
  byDocumentId(documentId: string): ResourceRecord | null;
};

/** The only reading of the durable alias dictionary; build it once per projection. */
export function resourceIdentityIndex(records: readonly ResourceRecord[]): ResourceIdentityIndex {
  const handles = new Map<string, ResourceRecord>();
  const current = new Map<string, ResourceRecord[]>();
  const aliases = new Map<string, ResourceRecord[]>();
  const add = (index: Map<string, ResourceRecord[]>, id: string, record: ResourceRecord) =>
    index.set(id, [...(index.get(id) ?? []), record]);
  for (const record of records) {
    handles.set(record.resource.handle, record);
    add(current, record.resource.identity.documentId, record);
    for (const alias of Object.keys(record.resource.aliases)) add(aliases, alias, record);
  }
  return {
    byHandle: (handle) => handles.get(handle) ?? null,
    byDocumentId(documentId) {
      const owners = current.get(documentId);
      if (owners && owners.length > 1)
        throw new Error("Document identity resolves to multiple resources");
      if (owners) return owners[0] ?? null;
      const obsolete = aliases.get(documentId);
      if (obsolete && obsolete.length > 1)
        throw new Error("Document alias resolves to multiple resources");
      return obsolete?.[0] ?? null;
    },
  };
}

export function resourceForDocumentIdentity(
  records: readonly ResourceRecord[],
  documentId: string,
): ResourceRecord | null {
  return resourceIdentityIndex(records).byDocumentId(documentId);
}

export function projectResourceNeedsRepair(
  projectId: string,
  record: ResourceRecord,
): {
  intentId: string;
  /** `create`: the server refused the document's first placement, so it exists only here. */
  kind: "set-location" | "delete" | "create";
  name: string;
  destination?: ResourceDestination;
} | null {
  const failed = record.intents.find(
    (intent) => intent.projectId === projectId && awaitsWriterRepair(intent),
  );
  if (!failed || failed.desired.kind === "set-folder-location") return null;
  const destination =
    failed.desired.kind === "delete"
      ? undefined
      : (namespaceRepairDestination(record.intents, failed) ?? undefined);
  return {
    intentId: failed.intentId,
    kind: failed.desired.kind,
    ...(destination ? { destination } : {}),
    // A nameless create has no name of the writer's to offer back.
    name:
      destination?.name ??
      (failed.desired.kind === "create" ? "" : (record.resource.canonical?.name ?? "document")),
  };
}

/** Resource-owned placement policy. UI consumers use ResourcePlacement to include ancestor changes. */
export function projectResourceLocation(
  projectId: string,
  record: ResourceRecord,
  lookup: DestinationParentLookup = () => null,
): ProjectResourceLocation | null {
  if (
    record.resource.lifecycle.kind === "terminal" ||
    record.intents.some(
      (intent) =>
        intent.projectId === projectId &&
        intentOwnsDeletionAt(intent, record.resource.observationVersion),
    )
  )
    return null;
  const placement = placementDestination(projectId, record);
  if (placement) {
    const location = destinationLocation(placement, lookup);
    if (location) return { ...location, provisional: false };
  }

  const create = record.intents
    .filter((intent) => intent.projectId === projectId && intent.desired.kind === "create")
    .at(-1)?.desired;
  // Refused filing returns a normal file to its accepted home, not a provisional reservation.
  const filed =
    create?.kind === "create" && create.destination
      ? true
      : record.intents.some(
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
