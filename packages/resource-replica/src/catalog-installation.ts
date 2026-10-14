/** Atomic installation policy from a server catalog view into durable local resources. */

import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  CatalogFileClassification,
  CatalogFileEntry,
  CatalogFolderEntry,
} from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { newerCanonicalObservation } from "./canonical-observation";
import { type CatalogCacheView, catalogFiles, indexCatalogView } from "./catalog";
import { catalogScopeBelongsToProject, sameCatalogScope } from "./catalog-scope";
import { joinReservation } from "./resource-join";
import { installCanonicalRefresh } from "./resource-namespace";
import {
  ownerOf,
  type ParentRef,
  type ResourceCatalogCheckpoint,
  type ResourceDescriptor,
  type ResourceLocation,
  type ResourceRecord,
  type ResourceWrite,
  sameOwner,
} from "./resource-records";
import { resourceLineageOwner } from "./resource-work-authority";

export type CatalogObservationFence = Readonly<{
  /** Folder canonical state captured before HTTP; a refresh barrier is proven only by its operation id. */
  folders?: ReadonlyMap<
    string,
    { revision: number; canonical: ResourceLocation; refreshOperationId?: string }
  >;
  /** Exact resource state captured before HTTP distinguishes local location changes from unrelated CAS. */
  resources?: ReadonlyMap<
    string,
    {
      revision: number;
      canonical: ResourceLocation | null;
      canonicalParent?: ParentRef;
      classification: CatalogFileClassification;
    }
  >;
}>;

export type CatalogInstallationPlan = Readonly<{
  checkpoint: ResourceCatalogCheckpoint;
  resources: readonly ResourceWrite[];
}>;

function resourceHandle(documentId: string): string {
  return `catalog:${documentId}`;
}

function displayedPath(path: string): string {
  return path ? `/${path}` : "/";
}

/** The canonical location a catalog view gives one of its file or folder entries. */
export function catalogEntryLocation(
  view: CatalogCacheView,
  entry: CatalogFileEntry | CatalogFolderEntry,
): ResourceLocation {
  if (!sameCatalogScope(entry.scope, view.scope)) throw new Error("Catalog file scope mismatch");
  const source = view.entries.get(entry.sourceId);
  if (source?.kind !== "source" || !sameCatalogScope(source.scope, view.scope))
    throw new Error("Catalog file source is unavailable");
  const parsed = parseContextUri(entry.uri);
  if (
    !parsed.ok ||
    parsed.value.normalized !== entry.uri ||
    parsed.value.scheme !== source.scheme ||
    parsed.value.path !== entry.path.join("/") ||
    entry.path.at(-1) !== entry.name
  )
    throw new Error("Catalog file URI is inconsistent with its source or path");

  const { authority, scheme, path } = parsed.value;
  if (view.scope.kind === "project") {
    if (authority.kind !== "contextual" || isWorkScopedProjectContextScheme(scheme))
      throw new Error("Catalog file URI has invalid project authority");
    return { scheme, path: displayedPath(path), name: entry.name, workId: null };
  }
  if (view.scope.kind === "user") {
    if (scheme !== "user" || authority.kind !== "contextual")
      throw new Error("Catalog file URI has invalid User authority");
    return { scheme, path: displayedPath(path), name: entry.name, workId: null };
  }
  if (!isWorkScopedProjectContextScheme(scheme))
    throw new Error("Catalog file URI is not Work scoped");
  if (view.scope.kind === "lineage") {
    if (scheme !== "scratch" || authority.kind !== "lineage")
      throw new Error("Catalog file URI has invalid chat authority");
    return {
      scheme,
      path: displayedPath(path),
      name: entry.name,
      ...resourceLineageOwner(view.scope, authority.rootThreadRef),
    };
  }
  if (authority.kind === "none") {
    return {
      scheme,
      path: displayedPath(path),
      name: entry.name,
      workId: view.scope.workId,
      workSlug: null,
    };
  }
  if (authority.kind !== "work") throw new Error("Catalog file URI has invalid Work authority");
  return {
    scheme,
    path: displayedPath(path),
    name: entry.name,
    workId: view.scope.workId,
    workSlug: authority.workSlug,
  };
}

/** Server catalog parent ids are identity evidence, even when the parent row is absent. */
export function catalogEntryParent(
  entry: CatalogFileEntry | CatalogFolderEntry,
  location: ResourceLocation,
): ParentRef {
  return entry.parentId === entry.sourceId
    ? { kind: "root", scheme: location.scheme, owner: ownerOf(location) }
    : { kind: "folder", folderId: entry.parentId };
}

export function sameResourceLocation(
  left: ResourceLocation | null,
  right: ResourceLocation | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.scheme === right.scheme &&
    left.path === right.path &&
    left.name === right.name &&
    sameOwner(left, right)
  );
}

function classificationFor(entry: CatalogFileEntry): CatalogFileClassification {
  if (entry.editable)
    return { editable: true, filetype: entry.filetype, schemaType: entry.schemaType };
  if (entry.disposition === "custom")
    return {
      editable: false,
      disposition: "custom",
      fileType: entry.fileType,
      mimeType: entry.mimeType,
      filetype: entry.filetype,
    };
  return {
    editable: false,
    disposition: "binary",
    fileType: entry.fileType,
    mimeType: entry.mimeType,
  };
}

function sameClassification(
  left: CatalogFileClassification,
  right: CatalogFileClassification,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexRecords(records: readonly ResourceRecord[]): {
  current: Map<string, ResourceRecord>;
  handles: Map<string, ResourceRecord>;
} {
  const current = new Map<string, ResourceRecord>();
  const handles = new Map<string, ResourceRecord>();
  for (const record of records) {
    const { resource } = record;
    if (handles.has(resource.handle)) throw new Error("Duplicate resource handle");
    handles.set(resource.handle, record);
    if (current.has(resource.identity.documentId))
      throw new Error("Duplicate current document identity");
    current.set(resource.identity.documentId, record);
  }
  return { current, handles };
}

function observedResourceWrite(input: {
  record: ResourceRecord;
  location: ResourceLocation;
  classification: CatalogFileClassification;
  parent: ParentRef;
  fence: CatalogObservationFence;
  observationVersion: string;
}): ResourceWrite | null {
  const { record, location, classification, parent, fence } = input;
  const current = record.resource;
  if (current.lifecycle.kind === "terminal") return revivedResourceWrite(input);
  if (current.lifecycle.kind !== "acknowledged") return null;
  const newer = newerCanonicalObservation(input.observationVersion, current.observationVersion);
  const observed = fence.resources?.get(current.handle);
  if (!observed) return null;
  if (
    observed.revision !== current.revision &&
    (!sameResourceLocation(observed.canonical, current.canonical) ||
      JSON.stringify(observed.canonicalParent) !== JSON.stringify(current.canonicalParent) ||
      !sameClassification(observed.classification, current.classification))
  )
    return null;

  const refresh = current.obligations.canonicalRefresh;
  const refreshed = refresh
    ? installCanonicalRefresh({
        record,
        operationId: refresh.operationId,
        location,
        parent,
        observationVersion: input.observationVersion,
      })
    : null;
  if (!newer) return refreshed;
  const base = refreshed?.next.resource ?? current;
  const obligations = { ...base.obligations };
  const next: ResourceDescriptor = {
    ...base,
    revision: current.revision + 1,
    classification,
    canonical: location,
    canonicalParent: parent,
    observationVersion: input.observationVersion,
    obligations,
  };
  return { expectedRevision: current.revision, next: { resource: next, intents: record.intents } };
}

/**
 * A terminal document holds the server version that proved its deletion. A strictly newer catalog
 * observation of it as present is a later restore: it returns as acknowledged at the server's location,
 * with content reacquired from the server. The request must have started after the terminal
 * transition, and any purge of the deleted lineage's local content must have finished.
 */
function revivedResourceWrite(
  input: Parameters<typeof observedResourceWrite>[0],
): ResourceWrite | null {
  const { record, location, classification, parent, fence } = input;
  const current = record.resource;
  if (current.lifecycle.kind !== "terminal" || current.obligations.cleanup) return null;
  if (fence.resources?.get(current.handle)?.revision !== current.revision) return null;
  // A versionless terminal cannot tell a restore from replayed pre-deletion history.
  const deletionVersion = current.lifecycle.deletionVersion;
  if (deletionVersion === undefined) return null;
  if (!newerCanonicalObservation(input.observationVersion, deletionVersion)) return null;
  const next: ResourceDescriptor = {
    ...current,
    revision: current.revision + 1,
    content: { kind: "unacquired" },
    classification,
    canonical: location,
    canonicalParent: parent,
    observationVersion: input.observationVersion,
    lifecycle: { kind: "acknowledged", availabilityGeneration: null },
    revivedFrom: {
      generation: current.lifecycle.generation,
      transitionId: current.lifecycle.transitionId,
    },
    obligations: {},
  };
  return { expectedRevision: current.revision, next: { resource: next, intents: record.intents } };
}

function discoveredResource(entry: CatalogFileEntry, location: ResourceLocation) {
  const handle = resourceHandle(entry.entryId);
  const resource: ResourceDescriptor = {
    handle,
    revision: 1,
    identity: { documentId: entry.entryId, revision: 1 },
    content: { kind: "unacquired" },
    classification: classificationFor(entry),
    canonical: location,
    canonicalParent: catalogEntryParent(entry, location),
    observationVersion: entry.observationVersion,
    lifecycle: { kind: "acknowledged", availabilityGeneration: null },
    aliases: {},
    obligations: {},
  };
  return { expectedRevision: null, next: { resource, intents: [] } } satisfies ResourceWrite;
}

function joinedReservation(
  records: readonly ResourceRecord[],
  current: ReadonlyMap<string, ResourceRecord>,
  entry: CatalogFileEntry,
  observed: {
    location: ResourceLocation;
    parent: ParentRef;
    classification: CatalogFileClassification;
  },
): ResourceWrite | null {
  for (const id of entry.joinedFrom ?? []) {
    const reservation = current.get(id);
    if (!reservation || !records.includes(reservation)) continue;
    const write = joinReservation({
      record: reservation,
      target: {
        documentId: entry.entryId,
        observationVersion: entry.observationVersion,
        ...observed,
      },
      settledAt: Date.now(),
    });
    if (write) return write;
  }
  return null;
}

/** Plan one atomic checkpoint/resource installation. Scope disappearance never deletes a resource. */
export function planCatalogInstallation(input: {
  projectId: string;
  records: readonly ResourceRecord[];
  view: CatalogCacheView;
  previous?: ResourceCatalogCheckpoint | null;
  observedAfter?: CatalogObservationFence;
}): CatalogInstallationPlan {
  if (!catalogScopeBelongsToProject(input.projectId, input.view.scope))
    throw new Error("Catalog scope belongs to another project");
  if (
    input.previous &&
    (input.previous.projectId !== input.projectId ||
      !sameCatalogScope(input.previous.scope, input.view.scope))
  )
    throw new Error("Catalog checkpoint identity mismatch");
  const index = indexRecords(input.records);
  const resources: ResourceWrite[] = [];
  const fence = input.observedAfter ?? {};
  for (const entry of catalogFiles(input.view)) {
    const location = catalogEntryLocation(input.view, entry);
    const current = index.current.get(entry.entryId);
    if (current) {
      const write = observedResourceWrite({
        record: current,
        location,
        classification: classificationFor(entry),
        parent: catalogEntryParent(entry, location),
        fence,
        observationVersion: entry.observationVersion,
      });
      if (write) resources.push(write);
      continue;
    }
    // A device's create that joined this document: the reservation follows it instead of a
    // second record being discovered beside it.
    const joined = joinedReservation(input.records, index.current, entry, {
      location,
      parent: catalogEntryParent(entry, location),
      classification: classificationFor(entry),
    });
    if (joined) {
      resources.push(joined);
      index.current.set(entry.entryId, joined.next);
      continue;
    }
    // Resource aliases are obsolete local identities. The server document still
    // using that ID is a different resource after remint and remains discoverable.
    const handle = resourceHandle(entry.entryId);
    const collision = index.handles.get(handle);
    if (collision) throw new Error("Catalog resource handle collision");
    const write = discoveredResource(entry, location);
    resources.push(write);
    index.current.set(entry.entryId, write.next);
    index.handles.set(handle, write.next);
  }
  return {
    checkpoint: {
      projectId: input.projectId,
      scope: input.view.scope,
      revision: (input.previous?.revision ?? 0) + 1,
      generation: input.view.generation,
      appliedRevision: input.view.appliedRevision,
      observedHeadRevision: input.view.observedHeadRevision,
      cursor: input.view.cursor,
      entries: [...input.view.entries.values()].sort((left, right) =>
        left.entryId.localeCompare(right.entryId),
      ),
    },
    resources,
  };
}

export function catalogViewFromCheckpoint(checkpoint: ResourceCatalogCheckpoint): CatalogCacheView {
  const indexed = indexCatalogView({
    scope: checkpoint.scope,
    generation: checkpoint.generation,
    appliedRevision: checkpoint.appliedRevision,
    observedHeadRevision: checkpoint.observedHeadRevision,
    cursor: checkpoint.cursor,
    entries: new Map(checkpoint.entries.map((entry) => [entry.entryId, entry])),
  });
  return indexed;
}
