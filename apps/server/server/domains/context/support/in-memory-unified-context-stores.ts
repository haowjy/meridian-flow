/**
 * In-memory context document stores for the unified port factory. Scoped like
 * Drizzle provisioning: manuscript/kb per project, user per user, scratch/uploads
 * per Work. Not part of the runtime export surface — tests import via test-support.
 */

import type { Filetype } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import {
  createInMemoryContextDocumentStoreBacking,
  findInMemoryContextDocumentsById,
  InMemoryContextDocumentStore,
  type InMemoryContextDocumentStoreBacking,
  InMemoryContextTreeMutationStore,
} from "../adapters/context-fs/in-memory-store.js";
import type { ProjectContextFsScheme, WorkScopedContextFsScheme } from "../ports/context-port.js";
import type { ContextTreeMutationStore } from "../ports/context-tree-mutation-store.js";

export interface InMemoryUnifiedContextStoreRegistry {
  backing: InMemoryContextDocumentStoreBacking;
  projectStores: Map<string, InMemoryContextDocumentStore>;
  workStores: Map<string, InMemoryContextDocumentStore>;
  mutationStore: InMemoryContextTreeMutationStore;
}

export function createInMemoryUnifiedContextStoreRegistry(): InMemoryUnifiedContextStoreRegistry {
  const backing = createInMemoryContextDocumentStoreBacking();
  return {
    backing,
    projectStores: new Map(),
    workStores: new Map(),
    mutationStore: new InMemoryContextTreeMutationStore(backing),
  };
}

function projectStoreKey(
  projectId: string,
  userId: string,
  scheme: ProjectContextFsScheme,
): string {
  if (scheme === "user") return `user:${userId}`;
  return `project:${projectId}:${scheme}`;
}

function workStoreKey(workId: string, scheme: WorkScopedContextFsScheme): string {
  return `work:${workId}:${scheme}`;
}

export function getInMemoryProjectContextStore(
  registry: InMemoryUnifiedContextStoreRegistry,
  projectId: string,
  userId: string,
  scheme: ProjectContextFsScheme,
): InMemoryContextDocumentStore {
  const key = projectStoreKey(projectId, userId, scheme);
  let store = registry.projectStores.get(key);
  if (!store) {
    store = new InMemoryContextDocumentStore({ sourceId: key, backing: registry.backing });
    registry.projectStores.set(key, store);
  }
  return store;
}

export function getInMemoryWorkContextStore(
  registry: InMemoryUnifiedContextStoreRegistry,
  workId: string,
  scheme: WorkScopedContextFsScheme,
): InMemoryContextDocumentStore {
  const key = workStoreKey(workId, scheme);
  let store = registry.workStores.get(key);
  if (!store) {
    store = new InMemoryContextDocumentStore({ sourceId: key, backing: registry.backing });
    registry.workStores.set(key, store);
  }
  return store;
}

export function getInMemoryContextTreeMutationStore(
  registry: InMemoryUnifiedContextStoreRegistry,
): ContextTreeMutationStore {
  return registry.mutationStore;
}

function projectionFromStore(
  registry: InMemoryUnifiedContextStoreRegistry,
  documentId: DocumentId,
): { markdown: string; filetype: Filetype } | null {
  const doc = findInMemoryContextDocumentsById(registry.backing, [documentId])[0];
  if (!doc) return null;
  return { markdown: doc.markdown, filetype: doc.filetype ?? "markdown" };
}

/** Resolve markdown projection for a document id across all in-memory context stores. */
export function findInMemoryDocumentProjection(
  registry: InMemoryUnifiedContextStoreRegistry,
  documentId: DocumentId,
): { markdown: string; filetype: Filetype } | null {
  return projectionFromStore(registry, documentId);
}
