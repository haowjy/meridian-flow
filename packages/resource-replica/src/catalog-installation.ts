/** Atomic installation policy from a server catalog view into durable local resources. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { CatalogFileClassification, CatalogFileEntry } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { type CatalogCacheView, catalogFiles, indexCatalogView } from "./catalog";
import { catalogScopeBelongsToProject, sameCatalogScope } from "./catalog-scope";
import { installCanonicalRefresh } from "./resource-namespace";
import type {
  ResourceCatalogCheckpoint,
  ResourceDescriptor,
  ResourceLocation,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";

export type CatalogObservationFence = Readonly<{
  /** Exact resource state captured before HTTP distinguishes local location changes from unrelated CAS. */
  resources?: ReadonlyMap<
    string,
    {
      revision: number;
      canonical: ResourceLocation | null;
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

function locationFor(view: CatalogCacheView, entry: CatalogFileEntry): ResourceLocation {
  if (!sameCatalogScope(entry.scope, view.scope)) throw new Error("Catalog file scope mismatch");
  const source = view.entries.get(entry.sourceId);
  if (
    source?.kind !== "source" ||
    view.invalidatedEntryIds.has(source.entryId) ||
    !sameCatalogScope(source.scope, view.scope)
  )
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
  if (authority.kind === "none") {
    return { scheme, path: displayedPath(path), name: entry.name, workId: view.scope.workId };
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

function sameLocation(left: ResourceLocation | null, right: ResourceLocation | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.scheme === right.scheme &&
    left.path === right.path &&
    left.name === right.name &&
    left.workId === right.workId &&
    left.workSlug === right.workSlug
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
  fence: CatalogObservationFence;
}): ResourceWrite | null {
  const { record, location, classification, fence } = input;
  const current = record.resource;
  if (current.lifecycle.kind !== "acknowledged") return null;
  const observed = fence.resources?.get(current.handle);
  if (!observed) return null;
  if (
    observed.revision !== current.revision &&
    (!sameLocation(observed.canonical, current.canonical) ||
      !sameClassification(observed.classification, current.classification))
  )
    return null;

  const refresh = current.obligations.canonicalRefresh;
  const refreshed = refresh
    ? installCanonicalRefresh({ record, operationId: refresh.operationId, location })
    : null;
  const changed =
    refreshed !== null ||
    !sameLocation(current.canonical, location) ||
    !sameClassification(current.classification, classification);
  const base = refreshed?.next.resource ?? current;
  const obligations = { ...base.obligations };
  if (!changed) return null;
  const next: ResourceDescriptor = {
    ...base,
    revision: current.revision + 1,
    classification,
    canonical: location,
    obligations,
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
    lifecycle: { kind: "acknowledged", availabilityGeneration: null },
    aliases: {},
    obligations: {},
  };
  return { expectedRevision: null, next: { resource, intents: [] } } satisfies ResourceWrite;
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
    const location = locationFor(input.view, entry);
    const current = index.current.get(entry.entryId);
    if (current) {
      const write = observedResourceWrite({
        record: current,
        location,
        classification: classificationFor(entry),
        fence,
      });
      if (write) resources.push(write);
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
      invalidatedEntryIds: [...input.view.invalidatedEntryIds].sort(),
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
    invalidatedEntryIds: new Set(checkpoint.invalidatedEntryIds),
  });
  return indexed;
}
