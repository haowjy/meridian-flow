/**
 * Unified context-port factory: composes project-scoped (manuscript/kb/user) and
 * work-scoped (scratch/uploads) ContextFS adapters into one router per scope.
 *
 * Contracts owns the scheme taxonomy; adapter assembly lives here as one deep
 * module. Source provisioning is delegated to context-source-provisioning.ts;
 * thread resolution to context-port-resolution.ts.
 */

import type { CanonicalContextAuthority } from "@meridian/contracts";
import {
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES,
  WORK_SCOPED_CONTEXT_URI_SCHEMES,
} from "@meridian/contracts/context-uri";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { ResolvedWorkAuthority, WorkSlug } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { projects } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import type { DocumentDerivationService } from "../collab/domain/ports/document-derivations.js";
import type { DocumentCreationAggregate } from "../collab/index.js";
import { createInMemoryCollabDomain } from "../collab/index.js";
import { sourceDestination } from "../file-policy/index.js";
import type { EventSink } from "../observability/index.js";
import { createDrizzleContextCatalog } from "./adapters/context-catalog.js";
import { ContextFS, type ContextFSDeps } from "./adapters/context-fs/context-fs.js";
import { lockContextNamespaces } from "./adapters/context-fs/document-locations.js";
import type { ContextDocumentMembershipObserver } from "./adapters/context-fs/drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "./adapters/context-fs/drizzle-tree-mutation-store.js";
import { createDrizzleContextOperationReceipts } from "./adapters/context-operation-receipts.js";
import { listsThroughLiveManifest } from "./adapters/document-address.js";
import { createDrizzleProjectContextAvailability } from "./adapters/project-context-availability.js";
import { createDrizzleScratchLineages } from "./adapters/scratch-lineages.js";
import { ContextOperationReceipts } from "./context/context-operation-receipts.js";
import { type ContextSourceBinding, createContextPortRouter } from "./context/router.js";
import { UNIFIED_CONTEXT_SCHEMES } from "./context/uri.js";
import {
  createLineageContextDocumentStore,
  createNoWorkContextDocumentStore,
  createProjectContextDocumentStore,
  createWorkContextDocumentStore,
  findNoWorkId,
} from "./context-source-provisioning.js";
import type { ContextSchemeAdapter } from "./ports/context-adapter.js";
import type { ContextCatalogMutationPort } from "./ports/context-catalog.js";
import type { ContextCommandTransaction } from "./ports/context-command-transaction.js";
import type { ContextDocumentStore } from "./ports/context-document-store.js";
import type {
  ContextPort,
  ContextScheme,
  ProjectContextFsScheme,
  ThreadContextView,
  WorkScopedContextFsScheme,
} from "./ports/context-port.js";
import type { DocumentArrivals } from "./ports/document-arrivals.js";
import type { LiveMembership } from "./ports/live-membership.js";
import type { ScratchLineage, ScratchLineages } from "./scratch-owner.js";
import {
  createInMemoryUnifiedContextStoreRegistry,
  getInMemoryContextTreeMutationStore,
  getInMemoryProjectContextStore,
  getInMemoryWorkContextStore,
  type InMemoryUnifiedContextStoreRegistry,
} from "./support/in-memory-unified-context-stores.js";

const PROJECT_CONTEXTFS_SCHEMES: readonly ProjectContextFsScheme[] =
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES;
const WORK_SCOPED_CONTEXTFS_SCHEMES: readonly WorkScopedContextFsScheme[] =
  WORK_SCOPED_CONTEXT_URI_SCHEMES;

export interface UnifiedContextPortFactory {
  lineages: ScratchLineages;
  forProject(
    projectId: string,
    userId: string,
    workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>,
    lineage?: ScratchLineage,
  ): ContextPort;
  forWork(
    authority: ResolvedWorkAuthority,
    projectId: string,
    userId: string,
    workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>,
    thread?: ThreadContextView,
  ): ContextPort;
}

type ManifestView = {
  projectId: string;
  workId?: string | null;
  threadId?: string | null;
  responseId?: string | null;
};

interface ContextStoreResolvers {
  lineages: ScratchLineages;
  resolveLineageStore(projectId: string, rootThreadId: string): ContextDocumentStore;
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
  resolveNoWorkStore(projectId: string, scheme: "uploads", userId?: string): ContextDocumentStore;
  resolveNoWorkId(projectId: string): Promise<string>;
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
  /** The live manifest: a move's note counts only its members (contract §10). */
  resolveManifestMembership(input: { projectId: ProjectId }): Promise<{ members: string[] }>;
  /** A cross-project move carries live membership to its destination project (§9.3). */
  transferLiveManifestMembership(
    documentIds: readonly DocumentId[],
    projects: { from: ProjectId; to: ProjectId },
  ): Promise<void>;
}

/** What every adapter of one port shares: storage, collab, and the reading thread. */
interface AdapterAssembly {
  links: ContextFSDeps["links"];
  storeResolvers: ContextStoreResolvers;
  documentSync: ContextFSDeps["documentSync"];
  documentCreation?: DocumentCreationAggregate;
  commandTransaction?: ContextCommandTransaction;
  thread?: ThreadContextView;
}

function contextFsAdapter(
  assembly: AdapterAssembly,
  deps: Pick<
    ContextFSDeps,
    "store" | "mutationStore" | "commandTransaction" | "scheme" | "manifestView" | "holder"
  >,
): ContextSchemeAdapter {
  return new ContextFS({
    ...deps,
    documentSync: assembly.documentSync,
    links: assembly.links,
    documentCreation: assembly.documentCreation,
    ...(assembly.thread ? { threadView: assembly.thread } : {}),
  });
}

function buildProjectContextFsAdapters(
  assembly: AdapterAssembly,
  projectId: string,
  userId: string,
  manifestView: ManifestView,
): Map<ContextScheme, ContextSchemeAdapter> {
  const { storeResolvers, commandTransaction, thread } = assembly;
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of PROJECT_CONTEXTFS_SCHEMES) {
    // Only an AI thread whose writes to this source are drafted has a draft
    // of the manifest. A port with no thread is a person's, and people always
    // write live (D20). Either way the membership is live and never branches.
    const schemeView =
      !thread || sourceDestination(scheme, thread.draftWork).kind === "live"
        ? { projectId }
        : manifestView;
    adapters.set(
      scheme,
      contextFsAdapter(assembly, {
        store: storeResolvers.resolveProjectStore(projectId, userId, scheme, schemeView),
        mutationStore: storeResolvers.resolveMutationStore(schemeView),
        commandTransaction: commandTransaction && {
          run: (operation) => commandTransaction.run(operation, [{ scheme, workId: null }]),
        },
        scheme,
        holder: { projectId },
        ...(listsThroughLiveManifest(scheme) ? { manifestView: schemeView } : {}),
      }),
    );
  }
  return adapters;
}

function buildWorkScopedContextFsAdapters(
  assembly: AdapterAssembly,
  workId: string,
  projectId: string,
  /** The Work's URI authority (`{ kind: "none" }` for No Work). */
  authority: CanonicalContextAuthority,
): Map<ContextScheme, ContextSchemeAdapter> {
  const { storeResolvers, commandTransaction } = assembly;
  // Scratch/uploads are canonical live documents even though their storage is
  // Work-scoped. The live-room gate reads the project manifest, so membership
  // must be registered in that view rather than a work-draft view.
  const mutationStore = storeResolvers.resolveMutationStore({ projectId });
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of WORK_SCOPED_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter(assembly, {
        store: storeResolvers.resolveWorkStore(workId, scheme, projectId),
        mutationStore,
        commandTransaction: commandTransaction && {
          run: (operation) => commandTransaction.run(operation, [{ scheme, workId: workId }]),
        },
        scheme,
        holder: { projectId, authority },
      }),
    );
  }
  return adapters;
}

function buildNoWorkContextFsAdapters(
  assembly: AdapterAssembly,
  projectId: string,
): Map<ContextScheme, ContextSchemeAdapter> {
  const { storeResolvers, commandTransaction } = assembly;
  const mutationStore = storeResolvers.resolveMutationStore({ projectId });
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of ["uploads"] as const) {
    adapters.set(
      scheme,
      contextFsAdapter(assembly, {
        store: storeResolvers.resolveNoWorkStore(projectId, scheme),
        mutationStore,
        commandTransaction: commandTransaction && {
          run: async (operation) => {
            const workId = await storeResolvers.resolveNoWorkId(projectId);
            return commandTransaction.run(operation, [{ scheme, workId }]);
          },
        },
        scheme,
        holder: { projectId, authority: { kind: "none" } },
      }),
    );
  }
  return adapters;
}

type ContextPortBuildScope =
  | {
      kind: "project";
      lineage?: ScratchLineage;
      projectId: string;
      userId: string;
      workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>;
    }
  | {
      kind: "work";
      authority: ResolvedWorkAuthority;
      projectId: string;
      userId: string;
      workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>;
      thread?: ThreadContextView;
    };

function buildUnifiedContextPort(input: {
  scope: ContextPortBuildScope;
  links: ContextFSDeps["links"];
  storeResolvers: ContextStoreResolvers;
  documentSync: ContextFSDeps["documentSync"];
  documentCreation?: DocumentCreationAggregate;
  commandTransaction?: ContextCommandTransaction;
  operationReceipts?: ContextOperationReceipts;
  moveLinks?: ConstructorParameters<
    typeof import("./context/context-tree-mover.js").ContextTreeMover
  >[2];
}): ContextPort {
  const { scope, storeResolvers } = input;
  const assembly: AdapterAssembly = {
    storeResolvers,
    documentSync: input.documentSync,
    links: input.links,
    documentCreation: input.documentCreation,
    commandTransaction: input.commandTransaction,
    ...(scope.kind === "work" && scope.thread ? { thread: scope.thread } : {}),
  };
  const adapters = buildProjectContextFsAdapters(
    assembly,
    scope.projectId,
    scope.userId,
    scope.kind === "work"
      ? {
          projectId: scope.projectId,
          workId: scope.authority.workId,
          threadId: scope.thread?.threadId,
          responseId: scope.thread?.responseId,
        }
      : { projectId: scope.projectId },
  );

  const workAuthorities = scope.workAuthorities;
  const primaryAdapters =
    scope.kind === "work" && scope.authority.workSlug !== null
      ? buildWorkScopedContextFsAdapters(
          assembly,
          scope.authority.workId,
          scope.projectId,
          scope.authority,
        )
      : buildNoWorkContextFsAdapters(assembly, scope.projectId);
  for (const [scheme, adapter] of primaryAdapters) adapters.set(scheme, adapter);

  const lineageSource = (lineage: ScratchLineage): ContextSourceBinding => ({
    adapter: contextFsAdapter(assembly, {
      store: storeResolvers.resolveLineageStore(scope.projectId, lineage.rootThreadId),
      mutationStore: storeResolvers.resolveMutationStore({ projectId: scope.projectId }),
      commandTransaction: input.commandTransaction,
      scheme: "scratch",
      holder: {
        projectId: scope.projectId,
        authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef },
      },
    }),
    authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef },
  });
  const sources = new Map<
    ContextScheme,
    ContextSourceBinding | (() => Promise<ContextSourceBinding | null>)
  >(
    [...adapters].map(([scheme, adapter]) => [
      scheme,
      {
        adapter,
        authority: (WORK_SCOPED_CONTEXTFS_SCHEMES as readonly string[]).includes(scheme)
          ? scope.kind === "work"
            ? scope.authority
            : { kind: "none" }
          : { kind: "contextual" },
      },
    ]),
  );
  const ownLineageId =
    scope.kind === "work" && scope.thread?.scratchOwner?.scope === "lineage"
      ? scope.thread.scratchOwner.rootThreadId
      : scope.kind === "project"
        ? (scope.lineage?.rootThreadId ?? null)
        : null;
  if (ownLineageId)
    sources.set("scratch", async () => {
      const lineage = await storeResolvers.lineages.byId(scope.projectId, ownLineageId);
      return lineage ? lineageSource(lineage) : null;
    });
  return createContextPortRouter({
    sources,
    resolveLineageSource: async (ref) => {
      const lineage = await storeResolvers.lineages.byRef(scope.projectId, ref);
      return lineage ? lineageSource(lineage) : null;
    },
    rootForThreadRef: (ref) => storeResolvers.lineages.rootForThreadRef(scope.projectId, ref),
    listLineages: () => storeResolvers.lineages.list(scope.projectId),
    workAuthorities,
    primaryWorkAuthority: scope.kind === "work" ? scope.authority : undefined,
    resolveWorkAdapters: (targetAuthority) =>
      buildWorkScopedContextFsAdapters(
        assembly,
        targetAuthority.workId,
        scope.projectId,
        targetAuthority,
      ),
    resolveNoWork: async () => {
      const workId =
        scope.kind === "work" && scope.authority.workSlug === null
          ? scope.authority.workId
          : await storeResolvers.resolveNoWorkId(scope.projectId);
      return {
        adapters: buildNoWorkContextFsAdapters(assembly, scope.projectId),
        workId,
      };
    },
    parseOptions: { barePathDefault: "manuscript", schemes: UNIFIED_CONTEXT_SCHEMES },
    commandTransaction: input.commandTransaction,
    operationReceipts: input.operationReceipts,
    moveLinks: input.moveLinks,
  });
}

function inMemoryNoWorkId(projectId: string): string {
  return `no-work:${projectId}`;
}

function createInMemoryStoreResolvers(
  registry: InMemoryUnifiedContextStoreRegistry,
  lineages: ScratchLineages,
): ContextStoreResolvers {
  return {
    lineages,
    resolveLineageStore(_projectId, rootThreadId) {
      return getInMemoryWorkContextStore(registry, rootThreadId, "scratch");
    },
    resolveProjectStore(projectId, userId, scheme, _manifestView) {
      return getInMemoryProjectContextStore(registry, projectId, userId, scheme);
    },
    resolveWorkStore(workId, scheme, _projectId) {
      return getInMemoryWorkContextStore(registry, workId, scheme);
    },
    resolveNoWorkStore(projectId, scheme) {
      return getInMemoryWorkContextStore(registry, inMemoryNoWorkId(projectId), scheme);
    },
    async resolveNoWorkId(projectId) {
      return inMemoryNoWorkId(projectId);
    },
    resolveMutationStore(_manifestView) {
      return getInMemoryContextTreeMutationStore(registry);
    },
  };
}

function createProductionStoreResolvers(
  db: Database,
  manifestMembership: ManifestMembershipPort,
  catalogMutations: ContextCatalogMutationPort,
  eventSink?: EventSink,
  arrivals?: DocumentArrivals,
): ContextStoreResolvers {
  const membershipObserverFor = (
    manifestView: ManifestView,
  ): ContextDocumentMembershipObserver => ({
    documentCreated: (documentId) =>
      manifestMembership.recordManifestDocumentCreated(documentId, manifestView),
    documentDeleted: (documentId) =>
      manifestMembership.recordManifestDocumentDeleted(documentId, manifestView),
  });
  const liveMembership: LiveMembership = {
    members: async (projectId) =>
      new Set((await manifestMembership.resolveManifestMembership({ projectId })).members),
    transfer: (documentIds, projects) =>
      manifestMembership.transferLiveManifestMembership(documentIds, projects),
  };

  return {
    lineages: createDrizzleScratchLineages(db),
    resolveLineageStore(projectId, rootThreadId) {
      return createLineageContextDocumentStore(
        db,
        projectId,
        rootThreadId,
        membershipObserverFor({ projectId }),
        catalogMutations,
        arrivals,
      );
    },
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
        catalogMutations,
        arrivals,
      );
    },
    resolveWorkStore(workId, scheme, projectId) {
      return createWorkContextDocumentStore(
        db,
        workId,
        scheme,
        projectId ? membershipObserverFor({ projectId }) : undefined,
        catalogMutations,
        arrivals,
      );
    },
    resolveNoWorkStore(projectId, scheme) {
      return createNoWorkContextDocumentStore(
        db,
        projectId,
        scheme,
        membershipObserverFor({ projectId }),
        catalogMutations,
        arrivals,
      );
    },
    async resolveNoWorkId(projectId) {
      const workId = await findNoWorkId(db, projectId);
      if (!workId) throw new Error(`No Work missing for project ${projectId}`);
      return workId;
    },
    resolveMutationStore(manifestView) {
      return new DrizzleContextTreeMutationStore(
        db,
        manifestView ? membershipObserverFor(manifestView) : undefined,
        catalogMutations,
        eventSink,
        arrivals,
        liveMembership,
      );
    },
  };
}

export function createInMemoryUnifiedContextPortFactory(
  options: {
    documentSync?: ContextFSDeps["documentSync"];
    storeRegistry?: InMemoryUnifiedContextStoreRegistry;
    lineages?: ScratchLineages;
  } = {},
): UnifiedContextPortFactory {
  const registry = options.storeRegistry ?? createInMemoryUnifiedContextStoreRegistry();
  const documentSync = options.documentSync ?? createInMemoryCollabDomain();
  const storeResolvers = createInMemoryStoreResolvers(
    registry,
    options.lineages ?? {
      async byId() {
        return null;
      },
      async rootForThreadRef() {
        return null;
      },
      async byRef() {
        return null;
      },
      async list() {
        return [];
      },
    },
  );

  return {
    lineages: storeResolvers.lineages,
    forProject(projectId, userId, workAuthorities, lineage) {
      return buildUnifiedContextPort({
        scope: { kind: "project", projectId, userId, workAuthorities, lineage },
        storeResolvers,
        documentSync,
        links: { within: (_key, operation) => operation() },
      });
    },
    forWork(authority, projectId, userId, workAuthorities, thread) {
      return buildUnifiedContextPort({
        scope: { kind: "work", authority, projectId, userId, workAuthorities, thread },
        storeResolvers,
        documentSync,
        links: { within: (_key, operation) => operation() },
      });
    },
  };
}

export function createProductionUnifiedContextPortFactory(options: {
  links: ContextFSDeps["links"];
  db: Database;
  documentSync: ContextFSDeps["documentSync"] & DocumentCreationAggregate;
  manifestMembership: ManifestMembershipPort;
  documentDerivations?: Pick<DocumentDerivationService, "flush">;
  catalogMutations?: ContextCatalogMutationPort;
  eventSink?: EventSink;
  /** Ahead-ref settlement for uploads and move-ins (contract §9.3). */
  arrivals?: DocumentArrivals;
}): UnifiedContextPortFactory {
  const catalogMutations =
    options.catalogMutations ??
    createDrizzleContextCatalog(options.db, undefined, {
      availabilityMutations: createDrizzleProjectContextAvailability(options.db, options.eventSink),
    });
  const storeResolvers = createProductionStoreResolvers(
    options.db,
    options.manifestMembership,
    catalogMutations,
    options.eventSink,
    options.arrivals,
  );

  function moveLinks(projectId: string, userId: string) {
    return {
      linkNoteProjectId: projectId,
      async flush(source: import("./context/context-tree-mover.js").ContextTreeDispatch) {
        if (!options.documentDerivations) return;
        const [project] = await options.db
          .select({ personal: projects.isPersonal })
          .from(projects)
          .where(eq(projects.id, projectId));
        await options.documentDerivations.flush({
          projectId,
          ...(source.scheme === "user" || project?.personal ? { personalOwnerId: userId } : {}),
        });
      },
    };
  }

  return {
    lineages: storeResolvers.lineages,
    forProject(projectId, userId, workAuthorities, lineage) {
      return buildUnifiedContextPort({
        scope: { kind: "project", projectId, userId, workAuthorities, lineage },
        storeResolvers,
        documentSync: options.documentSync,
        links: options.links,
        documentCreation: options.documentSync,
        moveLinks: moveLinks(projectId, userId),
        operationReceipts: new ContextOperationReceipts(
          createDrizzleContextOperationReceipts(options.db, { userId, projectId }),
        ),
        commandTransaction: {
          run: (operation, scopes = []) =>
            runInDrizzleTransaction(options.db, async () => {
              await lockContextNamespaces(options.db, { projectId, userId }, scopes);
              return operation();
            }),
        },
      });
    },
    forWork(authority, projectId, userId, workAuthorities, thread) {
      return buildUnifiedContextPort({
        scope: { kind: "work", authority, projectId, userId, workAuthorities, thread },
        storeResolvers,
        documentSync: options.documentSync,
        links: options.links,
        documentCreation: options.documentSync,
        moveLinks: moveLinks(projectId, userId),
        operationReceipts: new ContextOperationReceipts(
          createDrizzleContextOperationReceipts(options.db, { userId, projectId }),
        ),
        commandTransaction: {
          run: (operation, scopes = []) =>
            runInDrizzleTransaction(options.db, async () => {
              await lockContextNamespaces(options.db, { projectId, userId }, scopes);
              return operation();
            }),
        },
      });
    },
  };
}
