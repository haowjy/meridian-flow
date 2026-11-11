/** Resolves browser-local resource history without turning missing ownership into a default. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import {
  type ResourcePlacement,
  type ResourceRecord,
  resourceIdentityIndex,
} from "@meridian/resource-replica";
import { type ContextTab, isEditorContextTab } from "@/client/stores";
import { routeTargetForTab } from "../context/context-removal-planner";
import { contextTabFromResource } from "../context/context-tab-from-file";
import type { ContextRouteRequest } from "./project-route";

/** A document this device created: untitled (`new`), or filed since and still device-made. */
export type LocalDocument = Extract<ContextTab, { kind: "new" | "tracked" }>;

/**
 * The replica holds the handle-to-document pairing: a history entry's pointer names the handle,
 * and the replica says which document that is now, open in a tab or not.
 */
export function localDocumentsOf(
  projectId: string,
  projection: { records: readonly ResourceRecord[]; placement: ResourcePlacement },
): (resourceHandle: string) => LocalDocument | null {
  const index = resourceIdentityIndex(projection.records);
  return (resourceHandle) => {
    const record = index.byHandle(resourceHandle);
    return record ? contextTabFromResource(projectId, record, projection.placement) : null;
  };
}

export function resolveLocalDocumentSelection(input: {
  pointer: unknown;
  accountId: string;
  projectId: string;
  /** The replica's documents by handle; null until its first snapshot. */
  documentOf: ((resourceHandle: string) => LocalDocument | null) | null;
}):
  | { kind: "absent" | "unavailable" | "loading" }
  | {
      kind: "resolved";
      documentId: string;
      document: LocalDocument;
      /** A filed local document's own locator, which the pointer route repairs to. */
      target: ContextRouteRequest | null;
    } {
  if (input.pointer === undefined) return { kind: "absent" };
  const pointer = input.pointer;
  if (
    !pointer ||
    typeof pointer !== "object" ||
    !("version" in pointer) ||
    pointer.version !== 2 ||
    !("accountId" in pointer) ||
    pointer.accountId !== input.accountId ||
    !("projectId" in pointer) ||
    pointer.projectId !== input.projectId ||
    !("resourceHandle" in pointer) ||
    typeof pointer.resourceHandle !== "string" ||
    !pointer.resourceHandle
  )
    return { kind: "unavailable" };
  if (!input.documentOf) return { kind: "loading" };
  const document = input.documentOf(pointer.resourceHandle);
  if (document?.kind === "new")
    return { kind: "resolved", documentId: document.documentId, document, target: null };
  if (document?.kind === "tracked" && document.origin === "local-resource")
    return {
      kind: "resolved",
      documentId: document.documentId,
      document,
      target: routeTargetForTab(document),
    };
  return { kind: "unavailable" };
}

/** Screen entry may resume an open identity, never reopen a historical path. */
export function selectEditorEntryTab(input: {
  tabs: readonly ContextTab[];
  selectedDocumentId: string | undefined;
  recentRoutes: readonly WorkingSetRoute[];
}): ContextTab | null {
  const eligible = input.tabs.filter(isEditorContextTab);
  const selected = eligible.find((tab) => tab.documentId === input.selectedDocumentId);
  if (selected) return selected;
  for (const route of input.recentRoutes) {
    const tab = eligible.find((tab) => tab.documentId === route.documentId);
    if (tab) return tab;
  }
  return null;
}
