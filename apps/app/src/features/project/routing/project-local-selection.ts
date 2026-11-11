/** Resolves browser-local resource history without turning missing ownership into a default. */

import {
  type ResourcePlacement,
  type ResourceRecord,
  resourceIdentityIndex,
} from "@meridian/resource-replica";
import type { ContextTab } from "@/client/stores";
import { routeTargetForTab } from "../context/context-removal-planner";
import { contextTabFromResource } from "../context/context-tab-from-file";
import type { ContextRouteRequest } from "./project-route";

/** A document this device created: untitled (`new`), or filed since and still device-made. */
export type LocalDocument = Extract<ContextTab, { kind: "new" | "tracked" }>;

/**
 * The replica holds the handle-to-document pairing: a history entry's pointer names the handle,
 * and the replica says which document that is now, open in a tab or not.
 */
export function localDocumentsOf(projection: {
  records: readonly ResourceRecord[];
  placement: ResourcePlacement;
}): (resourceHandle: string) => LocalDocument | null {
  const index = resourceIdentityIndex(projection.records);
  return (resourceHandle) => {
    const record = index.byHandle(resourceHandle);
    return record ? contextTabFromResource(record, projection.placement) : null;
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
