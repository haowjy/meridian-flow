/** Browser adapters and React bindings for the durable untitled reconciler engine. */

import type { ProjectContextTreeNode } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  createUntitledContextDocument,
  getProjectContextTree,
  listProjectWorks,
} from "@/client/api/projects-api";
import { flushContextDesks } from "@/client/stores";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import {
  type ContextIdentityMutationService,
  createContextIdentityMutationService,
} from "./context-identity-mutation";
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

let identityMutations: ContextIdentityMutationService | null = null;

function browserDeps(): UntitledReconcilerDeps {
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
          await identityMutations?.materialized(entry.projectId, result);
        }
        return result;
      },
      async serverDocumentExists(entry) {
        const response = await getProjectContextTree(entry.projectId, entry.home.scheme, {
          workId: entry.home.workId,
        });
        return treeContainsDocument(response.tree.children, entry.documentId);
      },
      move(entry, source, desired: DesiredIdentity) {
        if (!identityMutations) throw new Error("Untitled identity cache adapter is unavailable");
        return identityMutations.move(
          entry.projectId,
          {
            scheme: source.scheme,
            path: source.path,
            ...(source.workId ? { workId: source.workId } : {}),
          },
          desired,
        );
      },
    },
  };
}

export function configureUntitledIdentityMutations(queryClient: QueryClient): () => void {
  const configured = createContextIdentityMutationService(queryClient);
  identityMutations = configured;
  return () => {
    if (identityMutations === configured) identityMutations = null;
  };
}

let shared: UntitledReconciler | null = null;

export function getUntitledReconciler(): UntitledReconciler {
  if (!shared && typeof window !== "undefined") shared = new UntitledReconciler(browserDeps());
  if (!shared) throw new Error("Untitled reconciler is browser-only");
  return shared;
}

export function registerUntitledCandidate(
  documentId: string,
  candidate: Parameters<UntitledReconciler["registerCandidate"]>[1],
): () => void {
  return getUntitledReconciler().registerCandidate(documentId, candidate);
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
  const reconciler = getUntitledReconciler();
  return useSyncExternalStore(
    reconciler.subscribe,
    () => reconciler.has(documentId),
    () => false,
  );
}

export function useUntitledPendingSince(documentId: string): number | null {
  const reconciler = getUntitledReconciler();
  return useSyncExternalStore(
    reconciler.subscribe,
    () => reconciler.pendingSince(documentId),
    () => null,
  );
}

export function useQueuedIdentityFailure(documentId: string): QueuedIdentityFailure | null {
  const reconciler = getUntitledReconciler();
  return useSyncExternalStore(
    reconciler.subscribe,
    () => reconciler.queuedIdentityFailure(documentId),
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
