/**
 * Unified context-port factory: composes project-scoped (manuscript/kb/user) and
 * Work-scoped (scratch) ContextFS adapters, and chat-scoped (uploads) ones into one router per scope.
 *
 * Contracts owns the scheme taxonomy; adapter assembly lives here as one deep
 * module. Source provisioning is delegated to context-source-provisioning.ts;
 * thread resolution to context-port-resolution.ts.
 */

import type { BranchId, CanonicalContextAuthority } from "@meridian/contracts";
import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import type { ResolvedWorkAuthority, WorkHandle } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { approveBranchWriteJoin } from "../../shared/branch-write-join.js";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import type { Branches } from "../collab/domain/branches.js";
import type { DocumentCreationAggregate, DraftPeerShadowAccess } from "../collab/index.js";
import { sourceDestination } from "../file-policy/index.js";
import { createDrizzleTopPrimaryChatResolver } from "../threads/adapters/drizzle/top-primary-chat.js";
import type { TopPrimaryChatResolver } from "../threads/index.js";
import { createDrizzleChatUploadsOwners } from "./adapters/chat-uploads-owners.js";
import { ContextFS, type ContextFSDeps } from "./adapters/context-fs/context-fs.js";
import { lockContextNamespaces } from "./adapters/context-fs/document-locations.js";
import type { ContextPlacement } from "./adapters/context-fs/placement.js";
import { createSourceTree } from "./adapters/context-fs/tree-writes.js";
import { createDrizzleOwnerLookup } from "./adapters/owner-lookup.js";
import { resolveActiveFolderUri } from "./adapters/project-context-availability.js";
import { createDrizzleScratchLineages } from "./adapters/scratch-lineages.js";
import type { ChatUploadsOwners } from "./chat-uploads-owners.js";
import { type ContextSourceBinding, createContextPortRouter } from "./context/router.js";
import { UNIFIED_CONTEXT_SCHEMES } from "./context/uri.js";
import {
  createChatContextDocumentStore,
  createLineageContextDocumentStore,
  createProjectContextDocumentStore,
  createWorkContextDocumentStore,
  findNoWorkId,
} from "./context-source-provisioning.js";
import type { ContextCopyCommandDeps } from "./copy/copy-command.js";
import { type CopyCommands, createCopyCommands } from "./copy/copy-commands.js";
import { bindOwners, type OwnerLookup } from "./owner-lookup.js";
import type { ContextSchemeAdapter } from "./ports/context-adapter.js";
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
import type { ProjectHintPort } from "./ports/project-hints.js";
import type { TreeListStore } from "./ports/tree-list-store.js";
import type { ScratchLineage, ScratchLineages } from "./scratch-owner.js";

const PROJECT_CONTEXTFS_SCHEMES: readonly ProjectContextFsScheme[] =
  PROJECT_SCOPED_CONTEXT_URI_SCHEMES;
/** Uploads belong to a chat, so a Work provisions Scratch only. */
const WORK_SCOPED_CONTEXTFS_SCHEMES: readonly WorkScopedContextFsScheme[] = ["scratch"];

export interface UnifiedContextPortFactory {
  lineages: ScratchLineages;
  topPrimaryChats: TopPrimaryChatResolver;
  /** Chats by handle, for `uploads://@c12/` addresses. */
  chats: ChatUploadsOwners;
  /** Where a chat's uploads and Scratch live, for errors and pointers. */
  chatFiles: OwnerLookup;
  forProject(
    projectId: string,
    userId: string,
    workAuthorities: ReadonlyMap<WorkHandle, ResolvedWorkAuthority>,
    lineage?: ScratchLineage,
    /** Whose uploads bare `uploads://` names, when the caller scopes to one chat. */
    chat?: UploadsOwner,
  ): ContextPort;
  forWork(
    authority: ResolvedWorkAuthority,
    projectId: string,
    userId: string,
    workAuthorities: ReadonlyMap<WorkHandle, ResolvedWorkAuthority>,
    thread?: ThreadContextView,
  ): ContextPort;
}

interface ContextStoreResolvers {
  lineages: ScratchLineages;
  chats: ChatUploadsOwners;
  chatFiles?: OwnerLookup;
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
}

/** What every adapter of one port shares: storage, collab, tree writes and the reading thread. */
interface AdapterAssembly {
  links: ContextFSDeps["links"];
  storeResolvers: ContextStoreResolvers;
  documentSync: ContextFSDeps["documentSync"];
  documentCreation?: DocumentCreationAggregate;
  commandTransaction?: ContextCommandTransaction;
  thread?: ThreadContextView;
  /** Resolves a draft-mode thread's branch; the adapters' tree writes go through `treeLists`. */
  branches: Pick<Branches, "viewForOwner">;
  treeLists: Pick<TreeListStore, "submit" | "read">;
  db: Database;
  arrivals?: DocumentArrivals;
  drafts: Pick<DraftPeerShadowAccess, "ensureCreatedDocumentDraft">;
  owner: { projectId: string; userId: string };
}

/**
 * Where an adapter's creates land (contract §2.3): a draft-mode thread's drafted source
 * is a draft placement, exactly as `sourceDestination` decides; people and auto-apply
 * Works are live.
 */
function placementFor(assembly: AdapterAssembly, scheme: ContextScheme): ContextPlacement {
  const { thread, branches } = assembly;
  if (!thread?.branchOwner) return { kind: "live" };
  const destination = sourceDestination(scheme, thread.branchOwner);
  const branch = {
    owner: thread.branchOwner.owner,
    threadId: thread.threadId as ThreadId,
    userId: assembly.owner.userId as UserId,
    branches,
  };
  return destination.kind === "draft" ? { kind: "draft", ...branch } : { kind: "live", branch };
}

function contextFsAdapter(
  assembly: AdapterAssembly,
  deps: Pick<ContextFSDeps, "store" | "commandTransaction" | "scheme" | "holder">,
): ContextSchemeAdapter {
  return new ContextFS({
    ...deps,
    writes: createSourceTree({
      store: assembly.treeLists,
      db: assembly.db,
      sourceId: () => deps.store.contextSourceId(),
    }),
    actor: `user:${assembly.owner.userId}`,
    drafts: assembly.drafts,
    ...(assembly.arrivals ? { arrivals: assembly.arrivals } : {}),
    placement: placementFor(assembly, deps.scheme),
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
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>();
  for (const scheme of WORK_SCOPED_CONTEXTFS_SCHEMES) {
    adapters.set(
      scheme,
      contextFsAdapter(assembly, {
        store: storeResolvers.resolveWorkStore(workId, scheme),
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
      workAuthorities: ReadonlyMap<WorkHandle, ResolvedWorkAuthority>;
    }
  | {
      kind: "work";
      authority: ResolvedWorkAuthority;
      projectId: string;
      userId: string;
      workAuthorities: ReadonlyMap<WorkHandle, ResolvedWorkAuthority>;
      thread?: ThreadContextView;
    };

function buildUnifiedContextPort(input: {
  scope: ContextPortBuildScope;
  links: ContextFSDeps["links"];
  storeResolvers: ContextStoreResolvers;
  documentSync: ContextFSDeps["documentSync"];
  documentCreation?: DocumentCreationAggregate;
  commandTransaction?: ContextCommandTransaction;
  branches: AdapterAssembly["branches"];
  treeLists: AdapterAssembly["treeLists"];
  db: Database;
  arrivals?: DocumentArrivals;
  drafts: AdapterAssembly["drafts"];
  resolveDestinationFolder?: (folderId: string) => Promise<string | null>;
  copyCommands?: CopyCommands;
  copy?: ContextCopyCommandDeps;
}): ContextPort {
  const { scope, storeResolvers, commandTransaction } = input;
  const assembly: AdapterAssembly = {
    storeResolvers,
    documentSync: input.documentSync,
    links: input.links,
    documentCreation: input.documentCreation,
    commandTransaction: input.commandTransaction,
    branches: input.branches,
    treeLists: input.treeLists,
    db: input.db,
    drafts: input.drafts,
    ...(input.arrivals ? { arrivals: input.arrivals } : {}),
    owner: { projectId: scope.projectId, userId: scope.userId },
    ...(scope.kind === "work" && scope.thread ? { thread: scope.thread } : {}),
  };
  const adapters = buildProjectContextFsAdapters(assembly, scope.projectId, scope.userId);

  const workAuthorities = scope.workAuthorities;
  if (scope.kind === "work" && scope.authority.workHandle !== null) {
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
    owners: storeResolvers.chatFiles && bindOwners(storeResolvers.chatFiles, scope.projectId),
    resolveLineageSource: async (ref) => {
      const lineage = await storeResolvers.lineages.byRef(scope.projectId, ref);
      return lineage ? lineageSource(lineage) : null;
    },
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
      scope.kind === "work" && scope.authority.workHandle === null
        ? scope.authority.workId
        : await storeResolvers.resolveNoWorkId(scope.projectId),
    parseOptions: { barePathDefault: "manuscript", schemes: UNIFIED_CONTEXT_SCHEMES },
    commandTransaction: input.commandTransaction,
    resolveDestinationFolder: input.resolveDestinationFolder,
    ...(input.copyCommands ? { copyCommands: input.copyCommands } : {}),
    ...(input.copy ? { copy: input.copy } : {}),
  });
}

function createProductionStoreResolvers(
  db: Database,
  hints: Pick<ProjectHintPort, "publishSourcesHint">,
): ContextStoreResolvers {
  return {
    lineages: createDrizzleScratchLineages(db),
    chats: createDrizzleChatUploadsOwners(db),
    resolveLineageStore(projectId, rootThreadId) {
      return createLineageContextDocumentStore(db, projectId, rootThreadId, hints);
    },
    resolveChatStore(projectId, chatId, scheme) {
      return createChatContextDocumentStore(db, projectId, chatId, scheme, hints);
    },
    resolveProjectStore(projectId, userId, scheme) {
      return createProjectContextDocumentStore(db, projectId, scheme, userId);
    },
    resolveWorkStore(workId, scheme) {
      return createWorkContextDocumentStore(db, workId, scheme);
    },
    async resolveNoWorkId(projectId) {
      const workId = await findNoWorkId(db, projectId);
      if (!workId) throw new Error(`No Work missing for project ${projectId}`);
      return workId;
    },
  };
}

export function createProductionUnifiedContextPortFactory(options: {
  topPrimaryChats?: TopPrimaryChatResolver;
  links: ContextFSDeps["links"];
  db: Database;
  documentSync: ContextFSDeps["documentSync"] &
    DocumentCreationAggregate &
    Pick<DraftPeerShadowAccess, "ensureCreatedDocumentDraft">;
  /** The project's tree lists: every create, move and delete is a `submit` on one. */
  treeLists: Pick<TreeListStore, "submit" | "read">;
  /** Told when a source is provisioned: the first write into a Work, a chat or a lineage makes it. */
  sourceHints: Pick<ProjectHintPort, "publishSourcesHint">;
  /** Ahead-ref settlement for uploads and move-ins (contract §9.3). */
  arrivals?: DocumentArrivals;
  /** The one branches resolver: draft placements read and write through it (§2.3). */
  branches: Branches;
  /** Copy's collab cut/bind and the object store its binaries duplicate into. */
  copy?: ContextCopyCommandDeps;
  /**
   * The Work mutation boundary: a branch command locks its branch's Work first
   * and touches the Work's projection after it (§13.2, S3).
   */
  pendingBranch: {
    mutate<T>(set: { branches: readonly BranchId[] }, operation: () => Promise<T>): Promise<T>;
  };
}): UnifiedContextPortFactory {
  const topPrimaryChats =
    options.topPrimaryChats ?? createDrizzleTopPrimaryChatResolver(options.db);
  const storeResolvers = createProductionStoreResolvers(options.db, options.sourceHints);
  const chatFiles = createDrizzleOwnerLookup(options.db, {
    chats: storeResolvers.chats,
    lineages: storeResolvers.lineages,
    topChats: topPrimaryChats,
  });
  storeResolvers.chatFiles = chatFiles;

  /**
   * One command transaction (§2.3, §14): Works (a branch write's Work among them), then the
   * branch row; nothing above it holds a Work row. The tree writes inside it take the list's
   * lock, which sorts before any document or namespace key.
   */
  function commandTransaction(projectId: string): ContextCommandTransaction {
    return {
      run: (operation, scopes = [], commandOptions = {}) =>
        runInDrizzleTransaction(options.db, async () => {
          const branchWrite = commandOptions.branch;
          const command: ContextCommandContext = { branch: null };
          const lockedScopes = typeof scopes === "function" ? await scopes() : scopes;
          await lockContextNamespaces(options.db, lockedScopes, {
            workIds: branchWrite?.owner.kind === "work" ? [branchWrite.owner.workId] : [],
            lineageRootIds:
              branchWrite?.owner.kind === "lineage" ? [branchWrite.owner.rootThreadId] : [],
            sourceIds: commandOptions.sourceIds ?? [],
            afterWorkLocks: async () => {
              if (!branchWrite) return;
              approveBranchWriteJoin();
              if (branchWrite.mode === "ensure") {
                command.branch = await options.branches.ensureActiveForWrite({
                  owner: branchWrite.owner,
                  projectId: projectId as ProjectId,
                  threadId: branchWrite.threadId,
                  userId: branchWrite.userId,
                });
              } else {
                const active = await options.branches.activeForOwner(branchWrite.owner);
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
        resolveDestinationFolder: (id) => resolveActiveFolderUri(options.db, projectId, userId, id),
        copyCommands: createCopyCommands(options.db, { userId, projectId }),
        commandTransaction: commandTransaction(projectId),
        branches: options.branches,
        treeLists: options.treeLists,
        db: options.db,
        drafts: options.documentSync,
        ...(options.arrivals ? { arrivals: options.arrivals } : {}),
        ...(options.copy ? { copy: options.copy } : {}),
      });
    },
    forWork(authority, projectId, userId, workAuthorities, thread) {
      return buildUnifiedContextPort({
        scope: { kind: "work", authority, projectId, userId, workAuthorities, thread },
        storeResolvers,
        documentSync: options.documentSync,
        links: options.links,
        documentCreation: options.documentSync,
        resolveDestinationFolder: (id) => resolveActiveFolderUri(options.db, projectId, userId, id),
        copyCommands: createCopyCommands(options.db, { userId, projectId }),
        commandTransaction: commandTransaction(projectId),
        branches: options.branches,
        treeLists: options.treeLists,
        db: options.db,
        drafts: options.documentSync,
        ...(options.arrivals ? { arrivals: options.arrivals } : {}),
        ...(options.copy ? { copy: options.copy } : {}),
      });
    },
  };
}
