/**
 * In-memory context document stores for the unified port factory. Scoped like
 * Drizzle provisioning: manuscript/kb per project, user per user, work/uploads
 * per Work. Not part of the runtime export surface — tests import via test-support.
 */

import { InMemoryContextDocumentStore } from "../adapters/context-fs/in-memory-store.js";
import type { ProjectContextFsScheme, WorkScopedContextFsScheme } from "../ports/context-port.js";

export interface InMemoryUnifiedContextStoreRegistry {
  projectStores: Map<string, InMemoryContextDocumentStore>;
  workStores: Map<string, InMemoryContextDocumentStore>;
}

export function createInMemoryUnifiedContextStoreRegistry(): InMemoryUnifiedContextStoreRegistry {
  return { projectStores: new Map(), workStores: new Map() };
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
    store = new InMemoryContextDocumentStore();
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
    store = new InMemoryContextDocumentStore();
    registry.workStores.set(key, store);
  }
  return store;
}
