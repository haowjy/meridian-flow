/** Project visibility policy over account-global resources and installed catalogs. */
import { namespaceRepairDestination } from "./namespace-journal-policy";
import { intentOwnsDeletionAt, placementDestination } from "./resource-intent-policy";
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
  // A spent id's failed placement is not the writer's to repair: it moves to a new id on its own.
  const failed =
    record.resource.serverHold === "spent"
      ? undefined
      : record.intents.find(
          (intent) => intent.projectId === projectId && intent.state === "needs-repair",
        );
  if (!failed || failed.desired.kind === "set-folder-location") return null;
  if (failed.desired.kind === "delete")
    return {
      intentId: failed.intentId,
      kind: "delete",
      name: record.resource.canonical?.name ?? "document",
    };
  const destination = namespaceRepairDestination(record.intents, failed) ?? undefined;
  return {
    intentId: failed.intentId,
    kind: record.resource.canonical ? "set-location" : "create",
    ...(destination ? { destination } : {}),
    // A nameless create has no name of the writer's to offer back.
    name: destination?.name ?? record.resource.canonical?.name ?? "",
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
    if (location)
      return {
        ...location,
        // The editor's nameless create invites a home until the writer names it. A server-held
        // document's provisional name is the catalog's.
        provisional:
          record.resource.serverHold !== "held" &&
          record.resource.materialization?.kind === "untitled" &&
          record.resource.materialization.unnamed === true,
      };
  }
  if (record.resource.canonical) return { ...record.resource.canonical, provisional: false };
  const materialization = record.resource.materialization;
  if (!materialization) return null;
  const folder = materialization.folderPath.split("/").filter(Boolean).join("/");
  const name = materialization.provisionalName;
  return {
    scheme: "unfiled",
    path: `/${[folder, name].filter(Boolean).join("/")}`,
    name,
    workId: null,
    provisional: materialization.kind === "untitled" && materialization.unnamed === true,
  };
}

export function resourceVisibleInProject(
  projectId: string,
  record: ResourceRecord,
  catalogs: readonly ResourceCatalogCheckpoint[],
): boolean {
  if (record.resource.copiedBy?.projectId === projectId) return true;
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
