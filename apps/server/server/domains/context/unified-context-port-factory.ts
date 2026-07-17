/**
 * Unified context-port factory: composes project-scoped (manuscript/kb/user) and
 * work-scoped (scratch/uploads) ContextFS adapters into one router per scope.
 *
 * Key decision: scheme taxonomy and adapter assembly live here as one deep module
 * (Voluma's context-schemes + context-adapter-factories collapsed in). Source
 * provisioning is delegated to context-source-provisioning.ts; thread resolution
 * to context-port-resolution.ts.
 */

import type { Database } from "@meridian/database";
import { Err, Ok } from "../../shared/result.js";
import type { MarkdownDocumentStore } from "../collab/index.js";
import { createInMemoryCollabDomain } from "../collab/index.js";
import { ContextFS } from "./adapters/context-fs/context-fs.js";
import {
  type ContextDocumentMembershipObserver,
  DrizzleContextTreeMutationStore,
} from "./adapters/context-fs/drizzle-store.js";
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
  getInMemoryContextTreeMutationStore,
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
  "scratch",
  "uploads",
] as const satisfies readonly WorkScopedContextFsScheme[];

export interface UnifiedContextPortFactory {
  forProject(projectId: string, userId: string): ContextPort;
  forWork(
    workId: string,
    projectId: string,
    userId: string,
    allowedAuthorities: ReadonlySet<string>,
    threadId?: string | null,
    responseId?: string | null,
  ): ContextPort;
}

type ManifestView = {
  projectId: string;
  workId?: string | null;
  threadId?: string | null;
  responseId?: string | null;
};

interface ContextStoreResolvers {
  resolveProjectStore(
    projectId: string,
    userId: string,
    scheme: ProjectContextFsScheme,
    manifestView?: ManifestView,
  ): ContextDocumentStore;
  resolveWorkStore(
    workId: string,
    scheme: WorkScopedContextFsScheme,
    projectId?: string,
  ): ContextDocumentStore;
  resolveMutationStore(
    manifestView?: ManifestView,
  ): import("./ports/context-tree-mutation-store.js").ContextTreeMutationStore;
}

/** Required production seam between project context storage and the live manifest. */
export interface ManifestMembershipPort {
  recordManifestDocumentCreated(
    documentId: string,
    view: { projectId: string; workId?: string | null; threadId?: string | null },
  ): Promise<void>;
  recordManifestDocumentDeleted(
    documentId: string,
    view: { projectId: string; workId?: string | null; threadId?: string | null },
  ): Promise<void>;
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
  async createTrackedDocument() {
    return Err({ code: "permission_denied" });
  },
  async ensureTrackedDocument() {
    return Err({ code: "permission_denied" });
  },
  async edit() {
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
  mutationStore: import("./ports/context-tree-mutation-store.js").ContextTreeMutationStore;
  documentSync: MarkdownDocumentStore;
  scheme: ContextScheme;
  manifestView?: ManifestView;
}): ContextSchemeAdapter {
  return new ContextFS(deps);
}

function buildProjectContextFsAdapters(
  projectId: string,
  userId: string,
  storeResolvers: ContextStoreResolvers,
  documentSync: MarkdownDocumentStore,
  manifestView?: ManifestView,
): Map<ContextScheme, ContextSchemeAdapter> {
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of PROJECT_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter({
        store: storeResolvers.resolveProjectStore(projectId, userId, scheme, manifestView),
        mutationStore: storeResolvers.resolveMutationStore(manifestView),
        documentSync,
        scheme,
        ...(scheme === "manuscript" && manifestView ? { manifestView } : {}),
      }),
    );
  }
  return adapters;
}

function buildWorkScopedContextFsAdapters(
  workId: string,
  projectId: string,
  storeResolvers: ContextStoreResolvers,
  documentSync: MarkdownDocumentStore,
): Map<ContextScheme, ContextSchemeAdapter> {
  // Scratch/uploads are canonical live documents even though their storage is
  // Work-scoped. The live-room gate reads the project manifest, so membership
  // must be registered in that view rather than a work-draft view.
  const manifestView = { projectId };
  const mutationStore = storeResolvers.resolveMutationStore(manifestView);
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of WORK_SCOPED_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter({
        store: storeResolvers.resolveWorkStore(workId, scheme, projectId),
        mutationStore,
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
      threadId?: string | null;
      responseId?: string | null;
    };

function buildUnifiedContextPort(input: {
  scope: ContextPortBuildScope;
  storeResolvers: ContextStoreResolvers;
  documentSync: MarkdownDocumentStore;
}): ContextPort {
  const { scope, storeResolvers, documentSync } = input;
  const adapters = buildProjectContextFsAdapters(
    scope.projectId,
    scope.userId,
    storeResolvers,
    documentSync,
    scope.kind === "work"
      ? {
          projectId: scope.projectId,
          workId: scope.workId,
          threadId: scope.threadId,
          responseId: scope.responseId,
        }
      : { projectId: scope.projectId },
  );

  if (scope.kind === "work") {
    for (const [scheme, adapter] of buildWorkScopedContextFsAdapters(
      scope.workId,
      scope.projectId,
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
            buildWorkScopedContextFsAdapters(
              targetWorkId,
              scope.projectId,
              storeResolvers,
              documentSync,
            )
        : undefined,
    parseOptions: { barePathDefault: "manuscript", schemes: UNIFIED_CONTEXT_SCHEMES },
  });
}

function createInMemoryStoreResolvers(
  registry: InMemoryUnifiedContextStoreRegistry,
): ContextStoreResolvers {
  return {
    resolveProjectStore(projectId, userId, scheme, _manifestView) {
      return getInMemoryProjectContextStore(registry, projectId, userId, scheme);
    },
    resolveWorkStore(workId, scheme, _projectId) {
      return getInMemoryWorkContextStore(registry, workId, scheme);
    },
    resolveMutationStore(_manifestView) {
      return getInMemoryContextTreeMutationStore(registry);
    },
  };
}

function createProductionStoreResolvers(
  db: Database,
  manifestMembership: ManifestMembershipPort,
): ContextStoreResolvers {
  const membershipObserverFor = (
    manifestView: ManifestView,
  ): ContextDocumentMembershipObserver => ({
    documentCreated: (documentId) =>
      manifestMembership.recordManifestDocumentCreated(documentId, manifestView),
    documentDeleted: (documentId) =>
      manifestMembership.recordManifestDocumentDeleted(documentId, manifestView),
  });

  return {
    resolveProjectStore(projectId, userId, scheme, manifestView) {
      // Every scheme registers creations in the project manifest. The ws
      // onConnect gate requires live-room membership for ALL documents, and
      // manifest seeding is scheme-agnostic — withholding the observer here
      // stranded kb/user documents outside the manifest, so their editors
      // connected to nothing (denied) and rendered permanently empty.
      return createProjectContextDocumentStore(
        db,
        projectId,
        scheme,
        userId,
        membershipObserverFor(manifestView ?? { projectId }),
      );
    },
    resolveWorkStore(workId, scheme, projectId) {
      return createWorkContextDocumentStore(
        db,
        workId,
        scheme,
        projectId ? membershipObserverFor({ projectId }) : undefined,
      );
    },
    resolveMutationStore(manifestView) {
      return new DrizzleContextTreeMutationStore(
        db,
        manifestView ? membershipObserverFor(manifestView) : undefined,
      );
    },
  };
}

function cacheKey(projectId: string, userId: string): string {
  return `${userId}:${projectId}`;
}

export function createInMemoryUnifiedContextPortFactory(
  options: {
    documentSync?: MarkdownDocumentStore;
    storeRegistry?: InMemoryUnifiedContextStoreRegistry;
  } = {},
): UnifiedContextPortFactory {
  const registry = options.storeRegistry ?? createInMemoryUnifiedContextStoreRegistry();
  const documentSync = options.documentSync ?? createInMemoryCollabDomain();
  const entries = new Map<string, ContextPort>();
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
    forWork(workId, projectId, userId, allowedAuthorities, threadId, responseId) {
      return buildUnifiedContextPort({
        scope: {
          kind: "work",
          workId,
          projectId,
          userId,
          allowedAuthorities,
          threadId,
          responseId,
        },
        storeResolvers,
        documentSync,
      });
    },
  };
}

export function createProductionUnifiedContextPortFactory(options: {
  db: Database;
  documentSync: MarkdownDocumentStore;
  manifestMembership: ManifestMembershipPort;
}): UnifiedContextPortFactory {
  const entries = new Map<string, ContextPort>();
  const storeResolvers = createProductionStoreResolvers(options.db, options.manifestMembership);

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
    forWork(workId, projectId, userId, allowedAuthorities, threadId, responseId) {
      return buildUnifiedContextPort({
        scope: {
          kind: "work",
          workId,
          projectId,
          userId,
          allowedAuthorities,
          threadId,
          responseId,
        },
        storeResolvers,
        documentSync: options.documentSync,
      });
    },
  };
}
