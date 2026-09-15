/**
 * context-tab-from-file — adapter from context-tree file metadata to ContextTab.
 *
 * Keeps desktop and phone context navigation on the same tab construction path
 * so file classification, schema type, and viewer metadata cannot drift between
 * shells.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import {
  projectResourceLocation,
  type ResourceRecord,
  resourceForDocumentIdentity,
} from "@meridian/resource-replica";
import type { CatalogFile } from "@/client/query/context-catalog-projection";

import type { ContextTab } from "@/client/stores";

export function contextTabFromFile(
  scheme: ProjectContextTreeScheme,
  file: CatalogFile,
  workId?: string | null,
): ContextTab {
  if (file.resourceHandle && file.resourceState === "local" && file.provisionalName) {
    return {
      kind: "new",
      documentId: file.documentId,
      name: file.name,
      resourceHandle: file.resourceHandle,
    };
  }
  const base = {
    documentId: file.documentId,
    scheme,
    path: file.path,
    name: file.name,
    provisionalName: file.provisionalName,
    ...(isWorkScopedProjectContextScheme(scheme) && workId ? { workId } : {}),
  };
  return {
    ...base,
    ...(file.editable
      ? {
          kind: "tracked" as const,
          editable: true as const,
          filetype: file.filetype,
          schemaType: file.schemaType,
          ...(file.resourceHandle
            ? {
                resourceHandle: file.resourceHandle,
                ...(file.resourceOrigin ? { origin: "local-resource" as const } : {}),
              }
            : {}),
        }
      : {
          kind: "viewer" as const,
          editable: false as const,
          fileType: file.fileType,
          mimeType: file.mimeType,
        }),
  };
}

/** One optimistic tab projection for a durable editable resource. */
export function contextTabFromResource(
  projectId: string,
  record: ResourceRecord,
): Extract<ContextTab, { kind: "new" | "tracked" }> | null {
  const location = projectResourceLocation(projectId, record);
  if (!location) return null;
  const { resource } = record;
  if (!resource.classification.editable) return null;
  const locallyCreated = record.intents.some((intent) => intent.desired.kind === "create");
  if (resource.lifecycle.kind === "local" && location.provisional) {
    return {
      kind: "new",
      documentId: resource.identity.documentId,
      name: location.name,
      resourceHandle: resource.handle,
    };
  }
  return {
    kind: "tracked",
    documentId: resource.identity.documentId,
    scheme: location.scheme,
    path: location.path,
    name: location.name,
    ...(location.workId ? { workId: location.workId } : {}),
    editable: true,
    filetype: resource.classification.filetype,
    schemaType: resource.classification.schemaType,
    provisionalName: location.provisional,
    ...(resource.content.kind === "exact"
      ? {
          resourceHandle: resource.handle,
          ...(locallyCreated ? { origin: "local-resource" as const } : {}),
        }
      : {}),
  };
}

export type ResourceTabProjection =
  | { kind: "none" }
  | { kind: "removed" }
  | {
      kind: "terminal";
      documentIds: readonly string[];
      generation: string;
    }
  | {
      kind: "projected";
      resourceHandle: string;
      tab: ContextTab;
    };

/** Reconcile any open tab by stable handle when known, otherwise by server document identity. */
export function projectResourceTab(
  projectId: string,
  tab: ContextTab,
  records: readonly ResourceRecord[],
): ResourceTabProjection {
  const record =
    (tab.resourceHandle
      ? records.find(({ resource }) => resource.handle === tab.resourceHandle)
      : undefined) ?? resourceForDocumentIdentity(records, tab.documentId);
  if (!record) return { kind: "none" };
  if (record.resource.lifecycle.kind === "terminal")
    return {
      kind: "terminal",
      documentIds: [...new Set([tab.documentId, record.resource.identity.documentId])],
      generation: record.resource.lifecycle.generation,
    };
  if (record.resource.content.kind === "unacquired") {
    const location = projectResourceLocation(projectId, record);
    if (!location || tab.kind === "new") return { kind: "removed" };
    const { resourceHandle: _resourceHandle, workId: _workId, ...existing } = tab;
    const projected = {
      ...existing,
      documentId: record.resource.identity.documentId,
      scheme: location.scheme,
      path: location.path,
      name: location.name,
      ...(location.workId ? { workId: location.workId } : {}),
      ...(existing.kind === "tracked" ? { provisionalName: location.provisional } : {}),
    } as Extract<ContextTab, { kind: "tracked" | "viewer" }>;
    return { kind: "projected", resourceHandle: record.resource.handle, tab: projected };
  }
  const projected = contextTabFromResource(projectId, record);
  return projected
    ? { kind: "projected", resourceHandle: record.resource.handle, tab: projected }
    : { kind: "removed" };
}
