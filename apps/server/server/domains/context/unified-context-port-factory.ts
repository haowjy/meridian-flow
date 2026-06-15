/**
 * Unified context-port factory: composes project-scoped (manuscript/kb/user) and
 * work-scoped (work/uploads) ContextFS adapters into one router per scope.
 *
 * Key decision: scheme taxonomy and adapter assembly live here as one deep module
 * (Voluma's context-schemes + context-adapter-factories collapsed in). Source
 * provisioning is delegated to context-source-provisioning.ts; thread resolution
 * to context-port-resolution.ts.
 */

import type { Database } from "@meridian/database";
import { Err, Ok } from "../../shared/result.js";
import { createInMemoryDocumentStore } from "../collab/adapters/in-memory/index.js";
import { createDocumentSyncService } from "../collab/domain/document-sync-service.js";
import type { DocumentSyncPort } from "../collab/ports/document-sync.js";
import { ContextFS } from "./adapters/context-fs/context-fs.js";
import { createContextPortRouter } from "./context/router.js";
import { UNIFIED_CONTEXT_SCHEMES } from "./context/uri.js";
import {
  createProjectContextDocumentStore,
  createWorkContextDocumentStore,
} from "./context-source-provisioning.js";
import type { ContextSchemeAdapter } from "./ports/context-adapter.js";
import type { ContextDocumentStore } from "./ports/context-document-store.js";
import type {
  ContextPort,
  ContextScheme,
  ProjectContextFsScheme,
  WorkScopedContextFsScheme,
} from "./ports/context-port.js";
import {
  createInMemoryUnifiedContextStoreRegistry,
  getInMemoryProjectContextStore,
  getInMemoryWorkContextStore,
  type InMemoryUnifiedContextStoreRegistry,
} from "./support/in-memory-unified-context-stores.js";

const PROJECT_CONTEXTFS_SCHEMES = [
  "manuscript",
  "kb",
  "user",
] as const satisfies readonly ProjectContextFsScheme[];
const WORK_SCOPED_CONTEXTFS_SCHEMES = [
  "work",
  "uploads",
] as const satisfies readonly WorkScopedContextFsScheme[];

export interface UnifiedContextPortFactory {
  forProject(projectId: string, userId: string): ContextPort;
  forWork(
    workId: string,
    projectId: string,
    userId: string,
    allowedAuthorities: ReadonlySet<string>,
  ): ContextPort;
}

interface ContextStoreResolvers {
  resolveProjectStore(
    projectId: string,
    userId: string,
    scheme: ProjectContextFsScheme,
  ): ContextDocumentStore;
  resolveWorkStore(workId: string, scheme: WorkScopedContextFsScheme): ContextDocumentStore;
}

const emptyWorkScopedAdapter: ContextSchemeAdapter = {
  name: "work-scoped (no active Work)",
  capabilities: { writable: false, searchable: false },
  async stat() {
    return Ok(null);
  },
  async read() {
    return Ok(null);
  },
  async write() {
    return Err({ code: "permission_denied" });
  },
  async writeBinary() {
    return Err({ code: "permission_denied" });
  },
  async list() {
    return Ok([]);
  },
  async mkdir() {
    return Err({ code: "permission_denied" });
  },
  async search() {
    return Ok([]);
  },
};

function contextFsAdapter(deps: {
  store: ContextDocumentStore;
  documentSync: DocumentSyncPort;
  scheme: ContextScheme;
}): ContextSchemeAdapter {
  return new ContextFS(deps);
}

function buildProjectContextFsAdapters(
  projectId: string,
  userId: string,
  storeResolvers: ContextStoreResolvers,
  documentSync: DocumentSyncPort,
): Map<ContextScheme, ContextSchemeAdapter> {
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of PROJECT_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter({
        store: storeResolvers.resolveProjectStore(projectId, userId, scheme),
        documentSync,
        scheme,
      }),
    );
  }
  return adapters;
}

function buildWorkScopedContextFsAdapters(
  workId: string,
  storeResolvers: ContextStoreResolvers,
  documentSync: DocumentSyncPort,
): Map<ContextScheme, ContextSchemeAdapter> {
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of WORK_SCOPED_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter({
        store: storeResolvers.resolveWorkStore(workId, scheme),
        documentSync,
        scheme,
      }),
    );
  }
  return adapters;
}

function addEmptyWorkScopedAdapters(adapters: Map<ContextScheme, ContextSchemeAdapter>): void {
  for (const scheme of WORK_SCOPED_CONTEXTFS_SCHEMES) {
    adapters.set(scheme, emptyWorkScopedAdapter);
  }
}

type ContextPortBuildScope =
  | { kind: "project"; projectId: string; userId: string }
  | {
      kind: "work";
      workId: string;
      projectId: string;
      userId: string;
      allowedAuthorities: ReadonlySet<string>;
    };

function buildUnifiedContextPort(input: {
  scope: ContextPortBuildScope;
  storeResolvers: ContextStoreResolvers;
  documentSync: DocumentSyncPort;
}): ContextPort {
  const { scope, storeResolvers, documentSync } = input;
  const adapters = buildProjectContextFsAdapters(
    scope.projectId,
    scope.userId,
    storeResolvers,
    documentSync,
  );

  if (scope.kind === "work") {
    for (const [scheme, adapter] of buildWorkScopedContextFsAdapters(
      scope.workId,
      storeResolvers,
      documentSync,
    )) {
      adapters.set(scheme, adapter);
    }
  } else {
    addEmptyWorkScopedAdapters(adapters);
  }

  return createContextPortRouter({
    adapters,
    allowedAuthorities: scope.kind === "work" ? scope.allowedAuthorities : undefined,
    primaryWorkId: scope.kind === "work" ? scope.workId : undefined,
    resolveWorkAdapters:
      scope.kind === "work"
        ? (targetWorkId) =>
            buildWorkScopedContextFsAdapters(targetWorkId, storeResolvers, documentSync)
        : undefined,
    parseOptions: { barePathDefault: "manuscript", schemes: UNIFIED_CONTEXT_SCHEMES },
  });
}

function createInMemoryStoreResolvers(
  registry: InMemoryUnifiedContextStoreRegistry,
): ContextStoreResolvers {
  return {
    resolveProjectStore(projectId, userId, scheme) {
      return getInMemoryProjectContextStore(registry, projectId, userId, scheme);
    },
    resolveWorkStore(workId, scheme) {
      return getInMemoryWorkContextStore(registry, workId, scheme);
    },
  };
}

function createProductionStoreResolvers(db: Database): ContextStoreResolvers {
  return {
    resolveProjectStore(projectId, userId, scheme) {
      return createProjectContextDocumentStore(db, projectId, scheme, userId);
    },
    resolveWorkStore(workId, scheme) {
      return createWorkContextDocumentStore(db, workId, scheme);
    },
  };
}

function cacheKey(projectId: string, userId: string): string {
  return `${userId}:${projectId}`;
}

export function createInMemoryUnifiedContextPortFactory(
  options: {
    documentSync?: DocumentSyncPort;
    storeRegistry?: InMemoryUnifiedContextStoreRegistry;
  } = {},
): UnifiedContextPortFactory {
  const documentSync =
    options.documentSync ?? createDocumentSyncService(createInMemoryDocumentStore());
  const entries = new Map<string, ContextPort>();
  const registry = options.storeRegistry ?? createInMemoryUnifiedContextStoreRegistry();
  const storeResolvers = createInMemoryStoreResolvers(registry);

  function portForProject(projectId: string, userId: string): ContextPort {
    const key = cacheKey(projectId, userId);
    let port = entries.get(key);
    if (!port) {
      port = buildUnifiedContextPort({
        scope: { kind: "project", projectId, userId },
        storeResolvers,
        documentSync,
      });
      entries.set(key, port);
    }
    return port;
  }

  return {
    forProject(projectId, userId) {
      return portForProject(projectId, userId);
    },
    forWork(workId, projectId, userId, allowedAuthorities) {
      return buildUnifiedContextPort({
        scope: { kind: "work", workId, projectId, userId, allowedAuthorities },
        storeResolvers,
        documentSync,
      });
    },
  };
}

export function createProductionUnifiedContextPortFactory(options: {
  db: Database;
  documentSync: DocumentSyncPort;
}): UnifiedContextPortFactory {
  const entries = new Map<string, ContextPort>();
  const storeResolvers = createProductionStoreResolvers(options.db);

  function portForProject(projectId: string, userId: string): ContextPort {
    const key = cacheKey(projectId, userId);
    let port = entries.get(key);
    if (!port) {
      port = buildUnifiedContextPort({
        scope: { kind: "project", projectId, userId },
        storeResolvers,
        documentSync: options.documentSync,
      });
      entries.set(key, port);
    }
    return port;
  }

  return {
    forProject(projectId, userId) {
      return portForProject(projectId, userId);
    },
    forWork(workId, projectId, userId, allowedAuthorities) {
      return buildUnifiedContextPort({
        scope: { kind: "work", workId, projectId, userId, allowedAuthorities },
        storeResolvers,
        documentSync: options.documentSync,
      });
    },
  };
}
