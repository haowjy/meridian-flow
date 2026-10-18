/**
 * Unified context-port factory: composes project-scoped (manuscript/kb/user) and
 * Work-scoped (scratch) ContextFS adapters, and chat-scoped (uploads) ones into one router per scope.
 *
 * Contracts owns the scheme taxonomy; adapter assembly lives here as one deep
 * module. Source provisioning is delegated to context-source-provisioning.ts;
 * thread resolution to context-port-resolution.ts.
 */

import type { BranchId, CanonicalContextAuthority } from "@meridian/contracts";
import {
  canonicalContextUri,
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES,
} from "@meridian/contracts/context-uri";
import type { ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { ResolvedWorkAuthority, WorkSlug } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { projects } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { approveBranchWriteJoin } from "../../shared/branch-write-join.js";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import type { Branches } from "../collab/domain/branches.js";
import type { DocumentDerivationService } from "../collab/domain/ports/document-derivations.js";
import type { DocumentCreationAggregate, DraftPeerShadowAccess } from "../collab/index.js";
import { createInMemoryCollabDomain } from "../collab/index.js";
import { sourceDestination } from "../file-policy/index.js";
import type { EventSink } from "../observability/index.js";
import { createDrizzleTopPrimaryChatResolver } from "../threads/adapters/drizzle/top-primary-chat.js";
import type { TopPrimaryChatResolver } from "../threads/index.js";
import { createDrizzleChatFileLookup } from "./adapters/chat-file-lookup.js";
import { createDrizzleChatUploadsOwners } from "./adapters/chat-uploads-owners.js";
import { createDrizzleContextCatalog } from "./adapters/context-catalog.js";
import { ContextFS, type ContextFSDeps } from "./adapters/context-fs/context-fs.js";
import type { ContextPlacement } from "./adapters/context-fs/create-placement.js";
import { lockContextNamespaces } from "./adapters/context-fs/document-locations.js";
import { createDrizzleBranchCreates } from "./adapters/context-fs/drizzle-branch-creates.js";
import { DrizzleContextTreeMutationStore } from "./adapters/context-fs/drizzle-tree-mutation-store.js";
import { createDrizzleContextOperationReceipts } from "./adapters/context-operation-receipts.js";
import {
  createDrizzleProjectContextAvailability,
  resolveActiveFolderUri,
} from "./adapters/project-context-availability.js";
import { createDrizzleScratchLineages } from "./adapters/scratch-lineages.js";
import type { ChatFileLookup } from "./chat-file-addresses.js";
import type { ChatUploadsOwners } from "./chat-uploads-owners.js";
import { ContextOperationReceipts } from "./context/context-operation-receipts.js";
import { type ContextSourceBinding, createContextPortRouter } from "./context/router.js";
import { UNIFIED_CONTEXT_SCHEMES } from "./context/uri.js";
import {
  createChatContextDocumentStore,
  createLineageContextDocumentStore,
  createProjectContextDocumentStore,
  createWorkContextDocumentStore,
  findNoWorkId,
} from "./context-source-provisioning.js";
import type { BranchCreatePort } from "./ports/branch-create.js";
import type { ContextSchemeAdapter } from "./ports/context-adapter.js";
import type { ContextCatalogMutationPort } from "./ports/context-catalog.js";
import type {
  ContextCommandContext,
  ContextCommandTransaction,
} from "./ports/context-command-transaction.js";
import type { ContextDocumentStore } from "./ports/context-document-store.js";
import type {
  ContextPort,
  ContextScheme,
  ProjectContextFsScheme,
  ThreadContextView,
  UploadsOwner,
  WorkScopedContextFsScheme,
} from "./ports/context-port.js";
import type { DocumentArrivals } from "./ports/document-arrivals.js";
import type { ScratchLineage, ScratchLineages } from "./scratch-owner.js";
import {
  createInMemoryUnifiedContextStoreRegistry,
  getInMemoryContextTreeMutationStore,
  getInMemoryProjectContextStore,
  getInMemoryWorkContextStore,
  type InMemoryUnifiedContextStoreRegistry,
} from "./support/in-memory-unified-context-stores.js";
import { findForward } from "./tree/forwards.js";
import type { HiddenNodeRepair } from "./tree/hidden-node-repair.js";

const PROJECT_CONTEXTFS_SCHEMES: readonly ProjectContextFsScheme[] =
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES;
/** Uploads belong to a chat, so a Work provisions Scratch only. */
const WORK_SCOPED_CONTEXTFS_SCHEMES: readonly WorkScopedContextFsScheme[] = ["scratch"];

export interface UnifiedContextPortFactory {
  lineages: ScratchLineages;
  topPrimaryChats: TopPrimaryChatResolver;
  /** Chats by handle, for `uploads://@/c12/` addresses. */
  chats: ChatUploadsOwners;
  /** Where a chat's uploads and Scratch live, for errors and pointers. */
  chatFiles: ChatFileLookup;
  forProject(
    projectId: string,
    userId: string,
    workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>,
    lineage?: ScratchLineage,
    /** Whose uploads bare `uploads://` names, when the caller scopes to one chat. */
    chat?: UploadsOwner,
  ): ContextPort;
  forWork(
    authority: ResolvedWorkAuthority,
    projectId: string,
    userId: string,
    workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>,
    thread?: ThreadContextView,
  ): ContextPort;
}

interface ContextStoreResolvers {
  lineages: ScratchLineages;
  chats: ChatUploadsOwners;
  /** Absent in the in-memory factory, which has no threads to ask. */
  chatFiles?: ChatFileLookup;
  resolveLineageStore(projectId: string, rootThreadId: string): ContextDocumentStore;
  /** The chat's uploads; `chatId` is a top primary thread id (`resolveTopPrimaryChat`). */
  resolveChatStore(projectId: string, chatId: string, scheme: "uploads"): ContextDocumentStore;
  resolveProjectStore(
    projectId: string,
    userId: string,
    scheme: ProjectContextFsScheme,
  ): ContextDocumentStore;
  resolveWorkStore(workId: string, scheme: WorkScopedContextFsScheme): ContextDocumentStore;
  resolveNoWorkId(projectId: string): Promise<string>;
  resolveMutationStore(): import("./ports/context-tree-mutation-store.js").ContextTreeMutationStore;
}

/** What every adapter of one port shares: storage, collab, and the reading thread. */
interface AdapterAssembly {
  links: ContextFSDeps["links"];
  storeResolvers: ContextStoreResolvers;
  documentSync: ContextFSDeps["documentSync"];
  documentCreation?: DocumentCreationAggregate;
  commandTransaction?: ContextCommandTransaction;
  thread?: ThreadContextView;
  /**
   * Where draft-mode threads' creates may land: Postgres resolves branches and makes draft
   * creates per source; the in-memory port is explicitly live-only.
   */
  placements: "live-only" | BranchPlacements;
  owner: { projectId: string; userId: string };
}

type BranchPlacements = {
  branches: Pick<Branches, "viewForWork">;
  creates(store: ContextDocumentStore): BranchCreatePort;
};

/**
 * Where an adapter's creates land (contract §2.3): a draft-mode thread's drafted source
 * is a draft placement, exactly as `sourceDestination` decides; people and auto-apply
 * Works are live (D20).
 */
function placementFor(
  assembly: AdapterAssembly,
  scheme: ContextScheme,
  store: ContextDocumentStore,
): ContextPlacement {
  const { thread, placements } = assembly;
  if (!thread || placements === "live-only") return { kind: "live" };
  const destination = sourceDestination(scheme, thread.branchWork);
  if (destination.kind !== "draft") return { kind: "live" };
  return {
    kind: "draft",
    workId: destination.workId as WorkId,
    threadId: thread.threadId as ThreadId,
    userId: assembly.owner.userId as UserId,
    branches: placements.branches,
    creates: placements.creates(store),
  };
}

function contextFsAdapter(
  assembly: AdapterAssembly,
  deps: Pick<ContextFSDeps, "store" | "mutationStore" | "commandTransaction" | "scheme" | "holder">,
): ContextSchemeAdapter {
  return new ContextFS({
    ...deps,
    placement: placementFor(assembly, deps.scheme, deps.store),
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
): Map<ContextScheme, ContextSchemeAdapter> {
  const { storeResolvers, commandTransaction } = assembly;
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of PROJECT_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter(assembly, {
        store: storeResolvers.resolveProjectStore(projectId, userId, scheme),
        mutationStore: storeResolvers.resolveMutationStore(),
        commandTransaction: commandTransaction && {
          run: (operation, _scopes, options) =>
            commandTransaction.run(operation, [{ scheme, workId: null }], options),
        },
        scheme,
        holder: { projectId },
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
  // Scratch is a canonical live document even though its storage is Work-scoped.
  const mutationStore = storeResolvers.resolveMutationStore();
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of WORK_SCOPED_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter(assembly, {
        store: storeResolvers.resolveWorkStore(workId, scheme),
        mutationStore,
        commandTransaction: commandTransaction && {
          run: (operation, _scopes, options) =>
            commandTransaction.run(operation, [{ scheme, workId: workId }], options),
        },
        scheme,
        holder: { projectId, authority },
      }),
    );
  }
  return adapters;
}

type ContextPortBuildScope =
  | {
      kind: "project";
      lineage?: ScratchLineage;
      chat?: UploadsOwner;
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
  placements: AdapterAssembly["placements"];
  resolveDestinationFolder?: (folderId: string) => Promise<string | null>;
  resolveForward?: (documentId: string) => Promise<string | null>;
  operationReceipts?: ContextOperationReceipts;
  moveLinks?: ConstructorParameters<
    typeof import("./context/context-tree-mover.js").ContextTreeMover
  >[2];
}): ContextPort {
  const { scope, storeResolvers, commandTransaction } = input;
  const assembly: AdapterAssembly = {
    storeResolvers,
    documentSync: input.documentSync,
    links: input.links,
    documentCreation: input.documentCreation,
    commandTransaction: input.commandTransaction,
    placements: input.placements,
    owner: { projectId: scope.projectId, userId: scope.userId },
    ...(scope.kind === "work" && scope.thread ? { thread: scope.thread } : {}),
  };
  const adapters = buildProjectContextFsAdapters(assembly, scope.projectId, scope.userId);

  const workAuthorities = scope.workAuthorities;
  if (scope.kind === "work" && scope.authority.workSlug !== null) {
    const primaryAdapters = buildWorkScopedContextFsAdapters(
      assembly,
      scope.authority.workId,
      scope.projectId,
      scope.authority,
    );
    for (const [scheme, adapter] of primaryAdapters) adapters.set(scheme, adapter);
  }

  const lineageSource = (lineage: ScratchLineage): ContextSourceBinding => ({
    adapter: contextFsAdapter(assembly, {
      store: storeResolvers.resolveLineageStore(scope.projectId, lineage.rootThreadId),
      mutationStore: storeResolvers.resolveMutationStore(),
      commandTransaction: input.commandTransaction,
      scheme: "scratch",
      holder: {
        projectId: scope.projectId,
        authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef },
      },
    }),
    authority: { kind: "lineage", rootThreadRef: lineage.rootThreadRef },
  });
  const chatSource = (owner: UploadsOwner): ContextSourceBinding => {
    const authority: CanonicalContextAuthority = owner.chatRef
      ? { kind: "chat", chatRef: owner.chatRef }
      : { kind: "contextual" };
    return {
      adapter: contextFsAdapter(assembly, {
        store: storeResolvers.resolveChatStore(scope.projectId, owner.chatId, "uploads"),
        mutationStore: storeResolvers.resolveMutationStore(),
        commandTransaction: commandTransaction && {
          run: (operation, _scopes, options) =>
            commandTransaction.run(operation, [{ scheme: "uploads", workId: null }], options),
        },
        scheme: "uploads",
        holder: { projectId: scope.projectId, authority },
      }),
      authority,
    };
  };
  const sources = new Map<
    ContextScheme,
    ContextSourceBinding | (() => Promise<ContextSourceBinding | null>)
  >(
    [...adapters].map(([scheme, adapter]) => [
      scheme,
      {
        adapter,
        authority:
          (WORK_SCOPED_CONTEXTFS_SCHEMES as readonly string[]).includes(scheme) &&
          scope.kind === "work"
            ? scope.authority
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
  const uploadsOwner = scope.kind === "work" ? scope.thread?.uploadsOwner : scope.chat;
  if (uploadsOwner) sources.set("uploads", chatSource(uploadsOwner));
  return createContextPortRouter({
    sources,
    resolveChatSource: async (ref) => {
      const chat = await storeResolvers.chats.byRef(scope.projectId, ref);
      if (!chat) return { kind: "missing" };
      return chat.live
        ? { kind: "found", binding: chatSource({ chatId: chat.chatId, chatRef: chat.chatRef }) }
        : { kind: "unavailable" };
    },
    chatFiles: async (ref) => (await storeResolvers.chatFiles?.byRef(scope.projectId, ref)) ?? null,
    resolveLineageSource: async (ref) => {
      const lineage = await storeResolvers.lineages.byRef(scope.projectId, ref);
      return lineage ? lineageSource(lineage) : null;
    },
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
    resolveNoWorkId: async () =>
      scope.kind === "work" && scope.authority.workSlug === null
        ? scope.authority.workId
        : await storeResolvers.resolveNoWorkId(scope.projectId),
    parseOptions: { barePathDefault: "manuscript", schemes: UNIFIED_CONTEXT_SCHEMES },
    commandTransaction: input.commandTransaction,
    resolveDestinationFolder: input.resolveDestinationFolder,
    ...(input.resolveForward ? { resolveForward: input.resolveForward } : {}),
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
  chats: ChatUploadsOwners,
): ContextStoreResolvers {
  return {
    lineages,
    chats,
    resolveLineageStore(_projectId, rootThreadId) {
      return getInMemoryWorkContextStore(registry, rootThreadId, "scratch");
    },
    resolveChatStore(_projectId, chatId, scheme) {
      return getInMemoryWorkContextStore(registry, `chat:${chatId}`, scheme);
    },
    resolveProjectStore(projectId, userId, scheme) {
      return getInMemoryProjectContextStore(registry, projectId, userId, scheme);
    },
    resolveWorkStore(workId, scheme) {
      return getInMemoryWorkContextStore(registry, workId, scheme);
    },
    async resolveNoWorkId(projectId) {
      return inMemoryNoWorkId(projectId);
    },
    resolveMutationStore() {
      return getInMemoryContextTreeMutationStore(registry);
    },
  };
}

function createProductionStoreResolvers(
  db: Database,
  catalogMutations: ContextCatalogMutationPort,
  arrivals?: DocumentArrivals,
  repair?: HiddenNodeRepair,
): ContextStoreResolvers {
  return {
    lineages: createDrizzleScratchLineages(db),
    chats: createDrizzleChatUploadsOwners(db),
    resolveLineageStore(projectId, rootThreadId) {
      return createLineageContextDocumentStore(
        db,
        projectId,
        rootThreadId,
        catalogMutations,
        arrivals,
        repair,
      );
    },
    resolveChatStore(projectId, chatId, scheme) {
      return createChatContextDocumentStore(
        db,
        projectId,
        chatId,
        scheme,
        catalogMutations,
        arrivals,
        repair,
      );
    },
    resolveProjectStore(projectId, userId, scheme) {
      return createProjectContextDocumentStore(
        db,
        projectId,
        scheme,
        userId,
        catalogMutations,
        arrivals,
        repair,
      );
    },
    resolveWorkStore(workId, scheme) {
      return createWorkContextDocumentStore(db, workId, scheme, catalogMutations, arrivals, repair);
    },
    async resolveNoWorkId(projectId) {
      const workId = await findNoWorkId(db, projectId);
      if (!workId) throw new Error(`No Work missing for project ${projectId}`);
      return workId;
    },
    resolveMutationStore() {
      return new DrizzleContextTreeMutationStore(db, catalogMutations, arrivals, repair);
    },
  };
}

export function createInMemoryUnifiedContextPortFactory(
  options: {
    documentSync?: ContextFSDeps["documentSync"];
    storeRegistry?: InMemoryUnifiedContextStoreRegistry;
    lineages?: ScratchLineages;
    chats?: ChatUploadsOwners;
    topPrimaryChats?: TopPrimaryChatResolver;
    chatFiles?: ChatFileLookup;
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
    options.chats ?? {
      async byRef() {
        return null;
      },
    },
  );

  if (options.chatFiles) storeResolvers.chatFiles = options.chatFiles;

  const resolveFolder =
    (
      projectId: string,
      userId: string,
      authorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>,
      primary?: ResolvedWorkAuthority,
    ) =>
    async (folderId: string): Promise<string | null> => {
      const sourceUris = new Map<string, string>();
      for (const scheme of PROJECT_CONTEXTFS_SCHEMES) {
        sourceUris.set(
          scheme === "user" ? `user:${userId}` : `project:${projectId}:${scheme}`,
          canonicalContextUri(scheme, ""),
        );
      }
      for (const authority of [...authorities.values(), ...(primary ? [primary] : [])])
        for (const scheme of WORK_SCOPED_CONTEXTFS_SCHEMES)
          sourceUris.set(
            `work:${authority.workId}:${scheme}`,
            canonicalContextUri(scheme, "", authority),
          );
      const folder = registry.backing.folders.get(folderId);
      if (!folder || folder.deletedAt) return null;
      const root = sourceUris.get(folder.contextSourceId);
      if (!root) return null;
      const parts: string[] = [];
      const seen = new Set<string>();
      let current: typeof folder | undefined = folder;
      while (current) {
        if (
          current.deletedAt ||
          current.contextSourceId !== folder.contextSourceId ||
          seen.has(current.id)
        )
          return null;
        seen.add(current.id);
        parts.unshift(current.name);
        const parentId = current.parentId;
        if (!parentId) break;
        current = registry.backing.folders.get(parentId);
        if (!current) return null;
      }
      return root + parts.join("/");
    };

  return {
    lineages: storeResolvers.lineages,
    chats: storeResolvers.chats,
    topPrimaryChats: options.topPrimaryChats ?? { resolveTopPrimaryChat: async () => null },
    chatFiles: options.chatFiles ?? { byRef: async () => null },
    forProject(projectId, userId, workAuthorities, lineage, chat) {
      return buildUnifiedContextPort({
        scope: { kind: "project", projectId, userId, workAuthorities, lineage, chat },
        storeResolvers,
        resolveDestinationFolder: resolveFolder(projectId, userId, workAuthorities),
        documentSync,
        links: { within: (_key, operation) => operation() },
        placements: "live-only",
      });
    },
    forWork(authority, projectId, userId, workAuthorities, thread) {
      return buildUnifiedContextPort({
        scope: { kind: "work", authority, projectId, userId, workAuthorities, thread },
        storeResolvers,
        resolveDestinationFolder: resolveFolder(projectId, userId, workAuthorities, authority),
        documentSync,
        links: { within: (_key, operation) => operation() },
        placements: "live-only",
      });
    },
  };
}

export function createProductionUnifiedContextPortFactory(options: {
  topPrimaryChats?: TopPrimaryChatResolver;
  links: ContextFSDeps["links"];
  db: Database;
  documentSync: ContextFSDeps["documentSync"] &
    DocumentCreationAggregate &
    Pick<DraftPeerShadowAccess, "ensureCreatedDocumentDraft" | "retractCreatedDocumentDraft">;
  documentDerivations?: Pick<DocumentDerivationService, "flush">;
  catalogMutations?: ContextCatalogMutationPort;
  eventSink?: EventSink;
  /** Ahead-ref settlement for uploads and move-ins (contract §9.3). */
  arrivals?: DocumentArrivals;
  /** Repair on touch (§12.4): creates report what they repaired; the mover's link count reads repair. */
  hiddenNodeRepair?: HiddenNodeRepair;
  /** The one branches resolver: draft placements read and write through it (§2.3). */
  branches: Branches;
  /**
   * The Work mutation boundary (decision D17): a branch command locks its branch's Work first
   * and touches the Work's projection after it (§13.2, S3).
   */
  pendingBranch: {
    mutate<T>(set: { branches: readonly BranchId[] }, operation: () => Promise<T>): Promise<T>;
  };
}): UnifiedContextPortFactory {
  const catalogMutations =
    options.catalogMutations ??
    createDrizzleContextCatalog(options.db, undefined, {
      availabilityMutations: createDrizzleProjectContextAvailability(options.db, options.eventSink),
    });
  const topPrimaryChats =
    options.topPrimaryChats ?? createDrizzleTopPrimaryChatResolver(options.db);
  const storeResolvers = createProductionStoreResolvers(
    options.db,
    catalogMutations,
    options.arrivals,
    options.hiddenNodeRepair,
  );
  const chatFiles = createDrizzleChatFileLookup(options.db, {
    chats: storeResolvers.chats,
    lineages: storeResolvers.lineages,
  });
  storeResolvers.chatFiles = chatFiles;

  const placements: BranchPlacements = {
    branches: options.branches,
    creates: (store) =>
      createDrizzleBranchCreates({
        db: options.db,
        sourceId: () => store.contextSourceId(),
        documents: options.documentSync,
        drafts: options.documentSync,
        ...(options.hiddenNodeRepair ? { repair: options.hiddenNodeRepair } : {}),
      }),
  };

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

  /**
   * One command transaction (§2.3, §14): Works (a branch write's Work among them), then the
   * branch row, then every namespace key in order; nothing above it holds a Work row.
   */
  function commandTransaction(projectId: string, userId: string): ContextCommandTransaction {
    return {
      run: (operation, scopes = [], commandOptions = {}) =>
        runInDrizzleTransaction(options.db, async () => {
          const branchWrite = commandOptions.branch;
          const command: ContextCommandContext = { branch: null };
          const lockedScopes = typeof scopes === "function" ? await scopes() : scopes;
          await lockContextNamespaces(options.db, { projectId, userId }, lockedScopes, {
            workIds: branchWrite ? [branchWrite.workId] : [],
            sourceIds: commandOptions.sourceIds ?? [],
            afterWorkLocks: async () => {
              if (!branchWrite) return;
              approveBranchWriteJoin();
              if (branchWrite.mode === "ensure") {
                command.branch = await options.branches.ensureActiveForWrite({
                  workId: branchWrite.workId,
                  projectId: projectId as ProjectId,
                  threadId: branchWrite.threadId,
                  userId: branchWrite.userId,
                });
              } else {
                const active = await options.branches.activeForWork(branchWrite.workId);
                command.branch = active ? await options.branches.lockActive(active.id) : null;
              }
            },
          });
          const branch = command.branch;
          return branch
            ? options.pendingBranch.mutate({ branches: [branch.id] }, () => operation(command))
            : operation(command);
        }),
    };
  }

  return {
    lineages: storeResolvers.lineages,
    chats: storeResolvers.chats,
    topPrimaryChats,
    chatFiles,
    forProject(projectId, userId, workAuthorities, lineage, chat) {
      return buildUnifiedContextPort({
        scope: { kind: "project", projectId, userId, workAuthorities, lineage, chat },
        storeResolvers,
        documentSync: options.documentSync,
        links: options.links,
        documentCreation: options.documentSync,
        moveLinks: moveLinks(projectId, userId),
        resolveDestinationFolder: (id) => resolveActiveFolderUri(options.db, projectId, userId, id),
        resolveForward: (id) => findForward(options.db, id, projectId as ProjectId),
        operationReceipts: new ContextOperationReceipts(
          createDrizzleContextOperationReceipts(options.db, { userId, projectId }),
        ),
        commandTransaction: commandTransaction(projectId, userId),
        placements,
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
        resolveDestinationFolder: (id) => resolveActiveFolderUri(options.db, projectId, userId, id),
        resolveForward: (id) => findForward(options.db, id, projectId as ProjectId),
        operationReceipts: new ContextOperationReceipts(
          createDrizzleContextOperationReceipts(options.db, { userId, projectId }),
        ),
        commandTransaction: commandTransaction(projectId, userId),
        placements,
      });
    },
  };
}
