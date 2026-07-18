/** Browser adapters and React bindings for the durable untitled reconciler engine. */

import type { ProjectContextTreeNode } from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";
import {
  createUntitledContextDocument,
  getProjectContextTree,
  listProjectWorks,
} from "@/client/api/projects-api";
import { flushContextDesks, useContextTabsStore } from "@/client/stores";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { ContextIdentityMutationService } from "./context-identity-mutation";
import type { DesiredIdentity } from "./identity-location";
import {
  type PendingUntitled,
  type QueuedIdentityFailure,
  resolveUntitledHome,
  UntitledReconciler,
  type UntitledReconcilerDeps,
} from "./untitled-reconciler";

function treeContainsDocument(
  nodes: readonly ProjectContextTreeNode[],
  documentId: string,
): boolean {
  return nodes.some((node) =>
    node.kind === "dir"
      ? treeContainsDocument(node.children, documentId)
      : node.documentId === documentId,
  );
}

function browserDeps(identityMutations: ContextIdentityMutationService): UntitledReconcilerDeps {
  const registry = getDocumentSessionRegistry();
  return {
    storage: localStorage,
    scheduler: {
      queue: (task) => queueMicrotask(task),
      setTimer: (task, delayMs) => setTimeout(task, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onOnline: (task) => {
        window.addEventListener("online", task);
        return () => window.removeEventListener("online", task);
      },
    },
    sessions: registry,
    newDocumentId: () => crypto.randomUUID(),
    api: {
      async resolveHome(projectId) {
        const works = await listProjectWorks(projectId);
        return resolveUntitledHome(works.defaultWorkId);
      },
      async create(entry) {
        const result = await createUntitledContextDocument(
          entry.projectId,
          entry.home.scheme,
          {
            documentId: entry.documentId,
            ...(entry.home.folderPath ? { folderPath: entry.home.folderPath } : {}),
          },
          { workId: entry.home.workId },
        );
        if (result.status !== "conflict") {
          await identityMutations.materialized(entry.projectId, result);
        }
        return result;
      },
      async serverDocumentExists(entry) {
        const response = await getProjectContextTree(entry.projectId, entry.home.scheme, {
          workId: entry.home.workId,
        });
        return treeContainsDocument(response.tree.children, entry.documentId);
      },
      async move(entry, source, desired: DesiredIdentity) {
        const { result } = await identityMutations.move(
          entry.documentId,
          entry.projectId,
          {
            scheme: source.scheme,
            path: source.path,
            ...(source.workId ? { workId: source.workId } : {}),
          },
          desired,
        );
        return result;
      },
    },
  };
}

let shared: UntitledReconciler | null = null;
const noopSubscribe = () => () => {};

export function getUntitledReconciler(
  identityMutations?: ContextIdentityMutationService,
): UntitledReconciler {
  if (!shared && typeof window !== "undefined" && identityMutations) {
    shared = new UntitledReconciler(browserDeps(identityMutations));
  }
  if (!shared) throw new Error("Untitled reconciler is browser-only");
  return shared;
}

export function registerUntitledCandidate(
  documentId: string,
  candidate: Parameters<UntitledReconciler["registerCandidate"]>[1],
): () => void {
  return getUntitledReconciler().registerCandidate(documentId, candidate);
}

export function syncUntitledReceiptOwners(): void {
  const referencedDocumentIds = new Set(
    Object.values(useContextTabsStore.getState().byProject).flatMap((desk) =>
      desk.tabs.map((tab) => tab.documentId),
    ),
  );
  getUntitledReconciler().setMaterializationReceiptOwners(referencedDocumentIds);
}

export function appendPendingUntitled(entry: PendingUntitled): void {
  getUntitledReconciler().append(entry);
  // The new tab is opened before this append. Flush after the reconciler has
  // made it eligible for desk persistence so a same-tick reload cannot lose it.
  flushContextDesks();
}

export function isUntitledPending(documentId: string): boolean {
  return getUntitledReconciler().has(documentId);
}

export function useUntitledPending(documentId: string): boolean {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.has(documentId) ?? false,
    () => false,
  );
}

export function useUntitledPendingSince(documentId: string): number | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.pendingSince(documentId) ?? null,
    () => null,
  );
}

export function useQueuedIdentityFailure(documentId: string): QueuedIdentityFailure | null {
  const reconciler = typeof window === "undefined" ? null : getUntitledReconciler();
  return useSyncExternalStore(
    reconciler?.subscribe ?? noopSubscribe,
    () => reconciler?.queuedIdentityFailure(documentId) ?? null,
    () => null,
  );
}

export function clearQueuedIdentityFailure(documentId: string): void {
  getUntitledReconciler().clearQueuedIdentityFailure(documentId);
}

export function queueUntitledIdentity(entry: PendingUntitled, desired: DesiredIdentity): void {
  getUntitledReconciler().queueIdentity(entry, desired);
  flushContextDesks();
}
