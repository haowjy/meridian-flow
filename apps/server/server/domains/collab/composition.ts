/** Composition root for the server collab domain over @meridian/agent-edit. */
import type { Hocuspocus } from "@hocuspocus/server";
import {
  type AgentEditCore,
  createAgentEditCodec,
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentLifecycle,
  type PersistedUpdate as JournalUpdate,
  type ReversalStore,
  type SyncStateStore,
  type UndoNotificationPort,
  type UpdateJournal,
  type UpdateMeta,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import type { DocumentId, ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { mdxCodec } from "@meridian/markup";
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import {
  createDocumentUriResolver,
  type DocumentUriResolver,
} from "../context/document-uri-resolver.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { PendingUndoNotificationRepository } from "../undo-notifications/index.js";
import {
  createDraftProjectionDocumentCoordinator,
  createDraftSessionFence,
  createDrizzleDraftAgentEditJournal,
  createDrizzleDraftSyncStateStore,
  createNoopDraftDocumentLifecycle,
  type DraftSessionFence,
  isDraftClosedForAppendError,
} from "./adapters/drizzle-draft-agent-edit.js";
import {
  createDrizzleDraftAcceptJournal,
  createDrizzleDraftStore,
} from "./adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createDrizzleSyncStateStore } from "./adapters/drizzle-sync-state.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createHocuspocusCoordinator } from "./adapters/hocuspocus-coordinator.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
  type InMemoryJournal,
} from "./adapters/in-memory/agent-edit.js";
import {
  createInMemoryDraftAcceptJournal,
  createInMemoryDraftStore,
} from "./adapters/in-memory/drafts.js";
import { createCheckpointService } from "./checkpoints.js";
import { touchDocumentActivity, updateMarkdownProjection } from "./domain/document-activity.js";
import { createDraftService, type DraftAcceptJournal, type DraftStore } from "./domain/drafts.js";
import {
  createMarkdownDocumentEngine,
  type RuntimeOrigin,
  syncErrorMessage,
} from "./domain/markdown-document.js";
import {
  createTurnLiveLineageReadModel,
  type TurnLiveLineageReadModel,
} from "./domain/turn-live-lineage.js";
import { reverseTurn as reverseTurnAcrossDocuments } from "./domain/turn-reversal.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";
import type {
  CollabDomain,
  DocumentWriteHook,
  ResponseWriteCommitFinalizeResult,
  ResponseWriteRollbackFinalizeResult,
  WriteMode,
} from "./index.js";

export type { DocumentWriteHook } from "./index.js";

type CollabDomainDeps = {
  db: Database;
  threads: ThreadModeRepository;
  projectPreferences: ProjectWriteModePreferences;
  eventSink?: EventSink;
  pendingUndoNotifications?: PendingUndoNotificationRepository;
};

type ThreadModeRepository = {
  findById(id: ThreadId): Promise<{ userId: UserId; projectId: ProjectId } | null>;
};

type ProjectWriteModePreferences = {
  read(userId: UserId, projectId: ProjectId): Promise<{ aiWriteMode?: WriteMode }>;
};

type CheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  reason: string;
  createdAt: string;
};

export type CollabFacadeStore = {
  createCheckpoint(
    docId: string,
    state: Uint8Array,
    reason: string,
    upToSeq: number,
  ): Promise<string>;
  getCheckpoint(id: string): Promise<CheckpointRecord | null>;
  listCheckpoints(docId: string): Promise<CheckpointRecord[]>;
  latestUpdate(docId: string): Promise<JournalUpdate | null>;
};

export type CollabFacadeDeps = {
  journal: UpdateJournal & ReversalStore;
  coordinator: DocumentCoordinator;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  store: CollabFacadeStore;
  hocuspocus(): Hocuspocus | null;
  bindHocuspocus(instance: Hocuspocus): void;
  eventSink?: EventSink;
  documentWriteHook?: DocumentWriteHook;
  documentUriResolver?: DocumentUriResolver;
  undoNotificationPort?: UndoNotificationPort;
  syncStateStore?: SyncStateStore;
  liveLineage?: TurnLiveLineageReadModel;
  draftStore: DraftStore;
  draftAcceptJournal: DraftAcceptJournal;
  threads: ThreadModeRepository;
  projectPreferences: ProjectWriteModePreferences;
  createDraftSessionCore?(input: { threadId: ThreadId }): AgentEditCore;
};

function createUndoNotificationPort(deps: {
  repository: PendingUndoNotificationRepository;
  documentUriResolver: DocumentUriResolver;
  eventSink?: EventSink;
}): UndoNotificationPort {
  return {
    async record(input) {
      const uri = await deps.documentUriResolver(input.docId);
      if (!uri) {
        if (deps.eventSink) {
          emitEvent(deps.eventSink, {
            level: "warn",
            source: "collab.undo_notifications",
            name: "document_uri_missing",
            payload: {
              docId: input.docId,
              threadId: input.threadId,
              representativeTurnId: input.writeHandleTurns[0]?.turnId,
            },
          });
        }
        return;
      }
      await deps.repository.record({
        threadId: input.threadId,
        writeHandles: input.writeHandles,
        writeHandleTurns: input.writeHandleTurns,
        uri,
        direction: input.direction,
      });
    },
  };
}

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const { journal, lifecycle, store } = createDrizzleCollabPersistence(deps.db);
  const syncStateStore = createDrizzleSyncStateStore(deps.db);
  const draftStore = createDrizzleDraftStore(deps.db);
  const liveLineageStore = createDrizzleTurnLiveLineageStore(deps.db);
  let boundHocuspocus: Hocuspocus | null = null;
  const hocuspocus = () => {
    if (!boundHocuspocus) throw new Error("Hocuspocus is not bound to the collab domain");
    return boundHocuspocus;
  };
  const coordinator = createHocuspocusCoordinator({ hocuspocus, journal });

  const documentUriResolver = createDocumentUriResolver(deps.db);

  return createFacade({
    journal,
    coordinator,
    lifecycle,
    store,
    hocuspocus: () => boundHocuspocus,
    bindHocuspocus(instance) {
      boundHocuspocus = instance;
    },
    eventSink: deps.eventSink,
    syncStateStore,
    documentUriResolver,
    liveLineage: createTurnLiveLineageReadModel({
      store: liveLineageStore,
      resolveDocumentUri: documentUriResolver,
    }),
    undoNotificationPort: deps.pendingUndoNotifications
      ? createUndoNotificationPort({
          repository: deps.pendingUndoNotifications,
          documentUriResolver,
          eventSink: deps.eventSink,
        })
      : undefined,
    draftStore,
    draftAcceptJournal: createDrizzleDraftAcceptJournal(deps.db, journal),
    threads: deps.threads,
    projectPreferences: deps.projectPreferences,
    createDraftSessionCore: ({ threadId }) =>
      createDrizzleDraftSessionCore({
        db: deps.db,
        threadId,
        liveCoordinator: coordinator,
        draftStore,
        eventSink: deps.eventSink,
      }),
    documentWriteHook: async ({ documentId, threadId, markdown, at }) => {
      const results = await Promise.allSettled([
        touchDocumentActivity(deps.db, documentId, threadId, at),
        updateMarkdownProjection(deps.db, documentId, markdown, at),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  });
}

export function createInMemoryCollabDomain(): CollabDomain {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const lifecycle = createInMemoryDocumentLifecycle(coordinator);
  const draftStore = createInMemoryDraftStore();
  let boundHocuspocus: Hocuspocus | null = null;

  return createFacade({
    journal,
    coordinator,
    lifecycle,
    store: inMemoryStore(journal),
    draftStore,
    draftAcceptJournal: createInMemoryDraftAcceptJournal(journal),
    threads: {
      async findById() {
        return null;
      },
    },
    projectPreferences: {
      async read() {
        return { aiWriteMode: "direct" as const };
      },
    },
    hocuspocus: () => boundHocuspocus,
    bindHocuspocus(instance) {
      boundHocuspocus = instance;
    },
  });
}

export type DraftSessionCoreDeps = {
  threadId: ThreadId;
  journal: UpdateJournal & ReversalStore;
  liveCoordinator: DocumentCoordinator;
  draftStore: Pick<DraftStore, "getActiveDraft" | "listUpdates">;
  syncStateStore?: SyncStateStore;
  eventSink?: EventSink;
  draftFence?: DraftSessionFence;
};

export function createDraftSessionCore(deps: DraftSessionCoreDeps): AgentEditCore {
  const schema = buildDocumentSchema();
  const markupCodec = mdxCodec({ schema });
  const codec = createAgentEditCodec(markupCodec);
  const model = yProsemirrorModel(schema);
  return createAgentEditCore({
    journal: deps.journal,
    coordinator: createDraftProjectionDocumentCoordinator({
      liveCoordinator: deps.liveCoordinator,
      draftStore: deps.draftStore,
      threadId: deps.threadId,
      draftFence: deps.draftFence,
    }),
    lifecycle: createNoopDraftDocumentLifecycle(),
    codec,
    model,
    defaultThreadId: deps.threadId,
    undoClientId: AGENT_EDIT_UNDO_CLIENT_ID,
    createRuntimeDoc: () => createCollabYDoc({ gc: false }),
    syncStateStore: deps.syncStateStore,
    // Draft sessions never emit undo notifications: draft edits are not reversible
    // (DRAFT_UNDO_UNSUPPORTED), so there is no human-undo to surface to the model.
    onInvariantViolation: agentEditInvariantPolicy(deps.eventSink),
  });
}

export function createDrizzleDraftSessionCore(deps: {
  db: Database;
  threadId: ThreadId;
  liveCoordinator: DocumentCoordinator;
  draftStore: DraftStore;
  eventSink?: EventSink;
}): AgentEditCore {
  const draftFence = createDraftSessionFence();
  return createDraftSessionCore({
    threadId: deps.threadId,
    journal: createDrizzleDraftAgentEditJournal(deps.db, {
      threadId: deps.threadId,
      draftFence,
    }),
    liveCoordinator: deps.liveCoordinator,
    draftStore: deps.draftStore,
    syncStateStore: createDrizzleDraftSyncStateStore(deps.db, { draftStore: deps.draftStore }),
    eventSink: deps.eventSink,
    draftFence,
  });
}

type ResponseSession = {
  mode: WriteMode;
  core: AgentEditCore;
  threadId: ThreadId;
  documentIds: Set<DocumentId>;
  capturedEpochs: Map<DocumentId, number>;
  stale?: boolean;
};

type PendingResponseSession = {
  threadId: ThreadId;
  documentIds: Set<DocumentId>;
  capturedEpochs: Map<DocumentId, number>;
  promise: Promise<ResponseSession>;
  stale?: boolean;
};

type ResponseSessionEntry = ResponseSession | PendingResponseSession;

type DraftClosedCommitResult = {
  responseId: string;
  status: "draft_closed";
  mode: "draft";
  documentCount: 0;
  updateCount: 0;
  documents: [];
  stagedCreates: { committed: []; discarded: [] };
};

function createResponseSessionRegistry(deps: {
  createLiveCore(): AgentEditCore;
  createDraftCore(input: { threadId: ThreadId }): AgentEditCore;
  resolveMode(threadId: ThreadId): Promise<WriteMode>;
}): {
  sessionMode(responseId: string): WriteMode | undefined;
  coreFor(responseId: string, threadId: ThreadId): Promise<ResponseSession>;
  trackDocument(responseId: string, threadId: ThreadId, documentId: DocumentId): void;
  isDraftClosed(responseId: string): boolean;
  commitResponse(responseId: string): Promise<Awaited<ReturnType<AgentEditCore["commitResponse"]>>>;
  rollbackResponse(
    responseId: string,
  ): Promise<Awaited<ReturnType<AgentEditCore["rollbackResponse"]>>>;
  invalidateDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
} {
  const sessions = new Map<string, ResponseSessionEntry>();
  const invalidationEpochs = new Map<string, number>();

  return {
    sessionMode(responseId) {
      const session = sessions.get(responseId);
      return session && "mode" in session ? session.mode : undefined;
    },

    async coreFor(responseId, threadId) {
      const existing = sessions.get(responseId);
      if (existing) return "promise" in existing ? existing.promise : existing;

      const pending: PendingResponseSession = {
        threadId,
        documentIds: new Set(),
        capturedEpochs: new Map(),
        promise: Promise.resolve().then(async () => {
          const mode = await deps.resolveMode(threadId);
          const resolved: ResponseSession = {
            mode,
            core: mode === "draft" ? deps.createDraftCore({ threadId }) : deps.createLiveCore(),
            threadId,
            documentIds: pending.documentIds,
            capturedEpochs: pending.capturedEpochs,
            stale: pending.stale,
          };
          sessions.set(responseId, resolved);
          return resolved;
        }),
      };
      sessions.set(responseId, pending);
      return pending.promise;
    },

    trackDocument(responseId, threadId, documentId) {
      const existing = sessions.get(responseId);
      const entry: ResponseSessionEntry =
        existing ??
        ({
          threadId,
          documentIds: new Set(),
          capturedEpochs: new Map(),
          promise: Promise.resolve().then(async () => {
            const mode = await deps.resolveMode(threadId);
            const current = sessions.get(responseId);
            const base = current && "promise" in current ? current : entry;
            const resolved: ResponseSession = {
              mode,
              core: mode === "draft" ? deps.createDraftCore({ threadId }) : deps.createLiveCore(),
              threadId,
              documentIds: base.documentIds,
              capturedEpochs: base.capturedEpochs,
              stale: base.stale,
            };
            sessions.set(responseId, resolved);
            return resolved;
          }),
        } satisfies PendingResponseSession);
      entry.documentIds.add(documentId);
      if (!entry.capturedEpochs.has(documentId)) {
        entry.capturedEpochs.set(documentId, currentEpoch(threadId, documentId));
      }
      if (!existing) sessions.set(responseId, entry);
    },

    isDraftClosed(responseId) {
      const entry = sessions.get(responseId);
      if (!entry || !("mode" in entry) || entry.mode !== "draft") return false;
      return shouldCloseDraftSession(entry);
    },

    async commitResponse(responseId) {
      const entry = sessions.get(responseId);
      const session = entry && "promise" in entry ? await entry.promise : entry;
      if (!session) return deps.createLiveCore().commitResponse(responseId);
      try {
        if (shouldCloseDraftSession(session)) {
          await session.core.rollbackResponse(responseId);
          return {
            responseId,
            status: "draft_closed",
            mode: "draft",
            documentCount: 0,
            updateCount: 0,
            documents: [],
            stagedCreates: { committed: [], discarded: [] },
          } satisfies DraftClosedCommitResult;
        }
        try {
          return await session.core.commitResponse(responseId);
        } catch (cause) {
          if (session.mode !== "draft" || !isDraftClosedForAppendError(cause)) throw cause;
          await session.core.rollbackResponse(responseId);
          return {
            responseId,
            status: "draft_closed",
            mode: "draft",
            documentCount: 0,
            updateCount: 0,
            documents: [],
            stagedCreates: { committed: [], discarded: [] },
          } satisfies DraftClosedCommitResult;
        }
      } finally {
        sessions.delete(responseId);
      }
    },

    async rollbackResponse(responseId) {
      const entry = sessions.get(responseId);
      const session = entry && "promise" in entry ? await entry.promise : entry;
      try {
        return await (session?.core ?? deps.createLiveCore()).rollbackResponse(responseId);
      } finally {
        sessions.delete(responseId);
      }
    },

    async invalidateDraft({ documentId, threadId }) {
      invalidationEpochs.set(
        epochKey(threadId, documentId),
        currentEpoch(threadId, documentId) + 1,
      );
      for (const session of sessions.values()) {
        if (session.threadId === threadId) session.stale = true;
      }
    },
  };

  function shouldCloseDraftSession(session: ResponseSession): boolean {
    return session.mode === "draft" && (session.stale === true || hasAdvancedEpoch(session));
  }

  function hasAdvancedEpoch(session: ResponseSession): boolean {
    for (const documentId of session.documentIds) {
      if (
        currentEpoch(session.threadId, documentId) > (session.capturedEpochs.get(documentId) ?? 0)
      ) {
        return true;
      }
    }
    return false;
  }

  function currentEpoch(threadId: ThreadId, documentId: DocumentId): number {
    return invalidationEpochs.get(epochKey(threadId, documentId)) ?? 0;
  }

  function epochKey(threadId: ThreadId, documentId: DocumentId): string {
    return `${threadId}:${documentId}`;
  }
}

function createAgentEditProxy(deps: {
  liveUtilityCore: AgentEditCore;
  registry: ReturnType<typeof createResponseSessionRegistry>;
}): AgentEditCore {
  return {
    async write(command, context) {
      const responseId = context?.responseId;
      if (!responseId) return deps.liveUtilityCore.write(command, context);
      const threadId = context.threadId as ThreadId | undefined;
      if (!threadId) return deps.liveUtilityCore.write(command, context);
      if ("documentId" in command && command.documentId) {
        deps.registry.trackDocument(responseId, threadId, command.documentId as DocumentId);
      }
      const session = await deps.registry.coreFor(responseId, threadId);
      if (deps.registry.isDraftClosed(responseId)) {
        await session.core.rollbackResponse(responseId);
        return {
          command: command.command,
          status: "internal_error",
          isError: true,
          text: "Draft review was closed before this response could write. Stop writing and wait for the next turn.",
        } as Awaited<ReturnType<AgentEditCore["write"]>>;
      }
      return session.core.write(command, context);
    },
    recover: deps.liveUtilityCore.recover,
    commitResponse: deps.registry.commitResponse,
    rollbackResponse: deps.registry.rollbackResponse,
    getAvailability: deps.liveUtilityCore.getAvailability,
    undo: deps.liveUtilityCore.undo,
    redo: deps.liveUtilityCore.redo,
    reverse: deps.liveUtilityCore.reverse,
    undoTurn: deps.liveUtilityCore.undoTurn,
    redoTurn: deps.liveUtilityCore.redoTurn,
    invalidateThread: deps.liveUtilityCore.invalidateThread,
  };
}

async function resolveThreadWriteMode(
  deps: Pick<CollabFacadeDeps, "threads" | "projectPreferences">,
  threadId: ThreadId,
): Promise<WriteMode> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return "direct";
  const prefs = await deps.projectPreferences.read(thread.userId, thread.projectId);
  return prefs.aiWriteMode ?? "direct";
}

export function createFacade(deps: CollabFacadeDeps): CollabDomain {
  const schema = buildDocumentSchema();
  const markupCodec = mdxCodec({ schema });
  const codec = createAgentEditCodec(markupCodec);
  const model = yProsemirrorModel(schema);
  const createLiveCore = () =>
    createAgentEditCore({
      journal: deps.journal,
      coordinator: deps.coordinator,
      lifecycle: deps.lifecycle,
      codec,
      model,
      undoClientId: AGENT_EDIT_UNDO_CLIENT_ID,
      createRuntimeDoc: () => createCollabYDoc({ gc: false }),
      syncStateStore: deps.syncStateStore,
      onInvariantViolation: agentEditInvariantPolicy(deps.eventSink),
    });
  const liveUtilityCore: AgentEditCore = createLiveCore();
  const responseRegistry = createResponseSessionRegistry({
    createLiveCore: () => liveUtilityCore,
    createDraftCore:
      deps.createDraftSessionCore ??
      (() => {
        throw new Error("Draft-mode response writes require a draft session core factory");
      }),
    resolveMode: (threadId) => resolveThreadWriteMode(deps, threadId),
  });
  const agentEditCore = createAgentEditProxy({
    liveUtilityCore,
    registry: responseRegistry,
  });
  const markdownDocuments = createMarkdownDocumentEngine({
    codec: markupCodec,
    model,
    journal: deps.journal,
    coordinator: deps.coordinator,
    lifecycle: deps.lifecycle,
    metaForOrigin,
    afterWrite: runDocumentWriteHook,
  });
  const draftLifecycle = createDraftService({
    draftStore: deps.draftStore,
    liveJournal: deps.draftAcceptJournal,
    liveCoordinator: deps.coordinator,
    invalidateInFlight: responseRegistry.invalidateDraft,
    refreshAcceptedProjection: ({ documentId, threadId }) =>
      refreshDocumentProjection(documentId, threadId, "collab.draft_accept"),
  });
  const draftService = {
    ...draftLifecycle,
    async previewMarkdown(input: { documentId: DocumentId; draftId: string }) {
      const doc = await draftLifecycle.buildDraftDoc(input);
      try {
        return markdownDocuments.serializeDoc(doc);
      } finally {
        doc.destroy();
      }
    },
  };

  async function refreshDocumentProjection(
    documentId: DocumentId,
    threadId?: ThreadId,
    source = "collab.document_write",
  ): Promise<void> {
    try {
      const read = await markdownDocuments.readAsMarkdown(documentId);
      if (!read.ok) {
        emitProjectionRefreshFailure({
          documentId,
          threadId,
          source,
          payload: {
            code: read.error.code,
            message: syncErrorMessage(read.error),
          },
        });
        return;
      }
      await runDocumentWriteHook({ documentId, threadId, markdown: read.value }, source);
    } catch (cause) {
      emitProjectionRefreshFailure({
        documentId,
        threadId,
        source,
        payload: unknownToEventPayload(cause),
      });
    }
  }

  async function runDocumentWriteHook(
    event: Omit<Parameters<DocumentWriteHook>[0], "at">,
    source = "collab.document_write",
  ): Promise<void> {
    if (!deps.documentWriteHook) return;
    const hookEvent = { ...event, at: new Date() };
    try {
      // The journal/live-doc write is the source of truth. The read-model hook is
      // awaited for freshness, but its failure is logged and never turns the
      // committed write into an error.
      await deps.documentWriteHook(hookEvent);
    } catch (cause) {
      if (!deps.eventSink) return;
      emitEvent(deps.eventSink, {
        level: "error",
        source,
        name: "post_write_hook.failed",
        payload: {
          documentId: hookEvent.documentId,
          threadId: hookEvent.threadId ?? null,
          ...unknownToEventPayload(cause),
        },
      });
    }
  }

  function emitProjectionRefreshFailure(input: {
    documentId: DocumentId;
    threadId?: ThreadId;
    source: string;
    payload: Record<string, unknown>;
  }): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "error",
      source: input.source,
      name: "projection_refresh.failed",
      payload: {
        documentId: input.documentId,
        threadId: input.threadId ?? null,
        ...input.payload,
      },
    });
  }

  async function finalizeResponseCommit(
    responseId: string,
    ctx: { threadId: ThreadId; turnId: TurnId },
  ): Promise<ResponseWriteCommitFinalizeResult> {
    const mode = responseRegistry.sessionMode(responseId) ?? "direct";
    const result = await agentEditCore.commitResponse(responseId);
    if ("status" in result && result.status === "draft_closed") {
      return {
        status: "draft_closed",
        responseId,
        mode: "draft",
        documents: [],
        stagedCreates: { committed: [], discarded: [] },
      };
    }
    if (mode === "draft") {
      return {
        status: "committed",
        documents: result.documents.map((document) => ({
          documentId: document.documentId as DocumentId,
          updateCount: document.updateCount,
        })),
        stagedCreates: {
          committed: [],
          discarded: result.stagedCreates.discarded as DocumentId[],
        },
      };
    }
    await Promise.all(
      result.documents.map((document) =>
        refreshDocumentProjection(
          document.documentId as DocumentId,
          ctx.threadId,
          "collab.response_finalize",
        ),
      ),
    );
    return {
      documents: result.documents.map((document) => ({
        documentId: document.documentId as DocumentId,
        updateCount: document.updateCount,
        ...(document.concurrentEdits ? { concurrentEdits: document.concurrentEdits } : {}),
      })),
      stagedCreates: {
        committed: result.stagedCreates.committed as DocumentId[],
        discarded: result.stagedCreates.discarded as DocumentId[],
      },
    };
  }

  async function finalizeResponseRollback(
    responseId: string,
  ): Promise<ResponseWriteRollbackFinalizeResult> {
    const result = await agentEditCore.rollbackResponse(responseId);
    return {
      stagedCreates: {
        committed: result.stagedCreates.committed as DocumentId[],
        discarded: result.stagedCreates.discarded as DocumentId[],
      },
    };
  }

  async function latestUpdateSeq(documentId: string): Promise<number> {
    return (await deps.store.latestUpdate(documentId))?.seq ?? 0;
  }

  function emitAgentEditInvariantViolation(payload: Record<string, unknown>): void {
    if (!deps.eventSink) return;
    emitEvent(deps.eventSink, {
      level: "error",
      source: "collab.agent_edit",
      name: "invariant_violation",
      payload,
    });
  }

  const liveLineage =
    deps.liveLineage ??
    createTurnLiveLineageReadModel({
      store: {
        listLiveDocumentIdsForTurn: (threadId, turnId) =>
          deps.journal.documentsForTurn(threadId, turnId),
      },
      resolveDocumentUri: async (documentId) => documentId,
    });

  const checkpoints = createCheckpointService({
    coordinator: deps.coordinator,
    store: deps.store,
    latestUpdateSeq,
    markdownDocuments,
  });
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal: deps.journal,
    hocuspocus: deps.hocuspocus,
    eventSink: deps.eventSink,
    metaForOrigin,
    latestUpdateSeq,
    emitAgentEditInvariantViolation,
  });

  return {
    agentEdit() {
      return agentEditCore;
    },

    drafts: draftService,

    ensureDocument(documentId) {
      return deps.lifecycle.ensureDocument(documentId);
    },

    readAsMarkdown(documentId) {
      return markdownDocuments.readAsMarkdown(documentId);
    },

    refreshDocumentProjection(input) {
      return refreshDocumentProjection(input.documentId, input.threadId);
    },

    listLiveDocumentsForTurn(threadId, turnId) {
      return liveLineage.listLiveDocumentsForTurn(threadId, turnId);
    },

    resolveThreadWriteMode(threadId) {
      return resolveThreadWriteMode(deps, threadId);
    },

    finalizeResponseCommit,

    finalizeResponseRollback,

    async writeFromMarkdown(documentId, markdown, origin) {
      return markdownDocuments.writeFromMarkdown(documentId, markdown, origin);
    },

    reverseTurn(input) {
      return reverseTurnAcrossDocuments(
        {
          reversalStore: deps.journal,
          agentEdit: agentEditCore,
          resolveDocumentUri: deps.documentUriResolver ?? (async (documentId) => documentId),
          refreshDocumentProjection: (projection) =>
            refreshDocumentProjection(projection.documentId, projection.threadId),
        },
        input,
      );
    },

    checkpoint: checkpoints.checkpoint,

    restore: checkpoints.restore,

    listCheckpoints: checkpoints.listCheckpoints,

    async writeDocument(input) {
      return markdownDocuments.writeDocument(input);
    },

    async editDocument(input) {
      return markdownDocuments.editDocument(input);
    },

    async getLastUpdateAttribution(documentId) {
      const latest = await deps.store.latestUpdate(documentId);
      if (!latest) {
        return { originType: null, actorTurnId: null, actorUserId: null, updateSeq: null };
      }
      return { ...attributionFromMeta(latest.meta), updateSeq: latest.seq };
    },

    bindHocuspocus(instance) {
      deps.bindHocuspocus(instance);
    },

    loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,

    persistConnectionUpdate: hocuspocusPersistence.persistConnectionUpdate,

    storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,

    drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,

    getPersistenceQueueMetrics: hocuspocusPersistence.getPersistenceQueueMetrics,
  };
}

function inMemoryStore(journal: InMemoryJournal): CollabFacadeStore {
  return {
    createCheckpoint: (docId, state, reason, upToSeq) =>
      journal.createCheckpoint(docId, state, reason, upToSeq),
    getCheckpoint: (id) => journal.getCheckpoint(id),
    listCheckpoints: (docId) => journal.listCheckpoints(docId),
    latestUpdate: (docId) => journal.latestUpdate(docId),
  };
}

function metaForOrigin(origin: RuntimeOrigin): UpdateMeta {
  if (origin.type === "agent") {
    return { origin: `agent:${origin.actorTurnId}`, actorTurnId: origin.actorTurnId, seq: 0 };
  }
  if (origin.type === "user") {
    const userId = "actorUserId" in origin ? origin.actorUserId : origin.userId;
    return { origin: `human:${userId}`, seq: 0 };
  }
  if (origin.type === "import") {
    // Imports initiated by a user are human journal updates; a future optional-user import maps to system.
    return origin.userId
      ? { origin: `human:${origin.userId}`, seq: 0 }
      : { origin: "system", seq: 0 };
  }
  return { origin: "system", seq: 0 };
}

function attributionFromMeta(meta: UpdateMeta): {
  originType: string | null;
  actorTurnId: TurnId | null;
  actorUserId: UserId | null;
} {
  if (meta.origin === "system") {
    return {
      originType: "system",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: null,
    };
  }
  const separator = meta.origin.indexOf(":");
  if (separator === -1) {
    return { originType: null, actorTurnId: null, actorUserId: null };
  }
  const kind = meta.origin.slice(0, separator);
  const id = meta.origin.slice(separator + 1);
  if (kind === "agent") {
    return {
      originType: "agent",
      actorTurnId: ((meta.actorTurnId ?? id) as TurnId) || null,
      actorUserId: null,
    };
  }
  if (kind === "human") {
    return {
      originType: "user",
      actorTurnId: (meta.actorTurnId as TurnId | undefined) ?? null,
      actorUserId: (id as UserId) || null,
    };
  }
  return { originType: null, actorTurnId: null, actorUserId: null };
}

function agentEditInvariantPolicy(eventSink?: EventSink): (message: string) => void {
  return (message) => {
    if (process.env.NODE_ENV !== "production") throw new Error(message);

    if (eventSink) {
      try {
        emitEvent(eventSink, {
          level: "error",
          source: "collab.agent_edit",
          name: "invariant_violation",
          payload: { message },
        });
      } catch (cause) {
        console.error(message, cause);
      }
      return;
    }

    console.error(message);
  };
}
