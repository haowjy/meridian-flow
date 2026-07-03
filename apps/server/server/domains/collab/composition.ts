/** Composition root for the server collab domain over @meridian/agent-edit. */
import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
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
import { draftRoomName } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import {
  AGENT_EDIT_UNDO_CLIENT_ID,
  buildDocumentSchema,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
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
import { createDraftReviewQueries } from "./domain/draft-review-queries.js";
import {
  createDraftWriteModeRouter,
  type ThreadModeRepository,
} from "./domain/draft-write-mode-router.js";
import { createDraftService, type DraftAcceptJournal, type DraftStore } from "./domain/drafts.js";
import {
  createMarkdownDocumentEngine,
  type RuntimeOrigin,
  syncErrorMessage,
} from "./domain/markdown-document.js";
import {
  createTurnLiveLineageReadModel,
  type TurnLiveLineageDocumentStore,
  type TurnLiveLineageReadModel,
} from "./domain/turn-live-lineage.js";
import { reverseTurn as reverseTurnAcrossDocuments } from "./domain/turn-reversal.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";
import type { CollabDomain, DocumentWriteHook, WriteMode } from "./index.js";

export type { DocumentWriteHook } from "./index.js";

type CollabDomainDeps = {
  db: Database;
  threads: ThreadModeRepository;
  eventSink?: EventSink;
  pendingUndoNotifications?: PendingUndoNotificationRepository;
};

const DRAFT_AGENT_BROADCAST_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "draft-agent-append" } },
} satisfies TransactionOrigin;

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
  latestUpdateSeq(docId: string): Promise<number>;
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
  liveLineage: TurnLiveLineageReadModel;
  draftStore: DraftStore;
  draftAcceptJournal: DraftAcceptJournal;
  threads: ThreadModeRepository;
  resolveWorkWriteMode?(workId: WorkId): Promise<WriteMode | null>;
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
    draftAcceptJournal: createDrizzleDraftAcceptJournal(deps.db),
    threads: deps.threads,
    resolveWorkWriteMode: async (workId) => {
      const [row] = await deps.db
        .select({ aiWriteMode: works.aiWriteMode })
        .from(works)
        .where(eq(works.id, workId))
        .limit(1);
      return row?.aiWriteMode === "draft"
        ? "draft"
        : row?.aiWriteMode === "direct"
          ? "direct"
          : null;
    },
    createDraftSessionCore: ({ threadId }) =>
      createDrizzleDraftSessionCore({
        db: deps.db,
        threadId,
        liveCoordinator: coordinator,
        lifecycle,
        draftStore,
        afterDraftUpdateAppended({ draftId, update }) {
          try {
            const draftDoc = boundHocuspocus?.documents.get(draftRoomName(draftId));
            if (draftDoc) Y.applyUpdate(draftDoc, update, DRAFT_AGENT_BROADCAST_ORIGIN);
          } catch (cause) {
            if (!deps.eventSink) return;
            emitEvent(deps.eventSink, {
              level: "warn",
              source: "collab.draft_review",
              name: "agent_append_broadcast.failed",
              payload: { draftId, ...unknownToEventPayload(cause) },
            });
          }
        },
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
    liveLineage: createTurnLiveLineageReadModel({
      store: createInMemoryTurnLiveLineageStore(journal),
      resolveDocumentUri: async (documentId) => documentId,
    }),
    threads: {
      async findById() {
        return null;
      },
    },
    resolveWorkWriteMode: async () => "direct",
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
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
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
    lifecycle: deps.lifecycle,
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
  lifecycle?: Pick<DocumentLifecycle, "ensureDocument">;
  draftStore: DraftStore;
  latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number>;
  afterDraftUpdateAppended?: (input: { draftId: string; update: Uint8Array }) => void;
  eventSink?: EventSink;
}): AgentEditCore {
  const draftFence = createDraftSessionFence();
  return createDraftSessionCore({
    threadId: deps.threadId,
    journal: createDrizzleDraftAgentEditJournal(deps.db, {
      threadId: deps.threadId,
      draftFence,
      latestLiveUpdateSeq: deps.latestLiveUpdateSeq,
      afterDraftUpdateAppended: deps.afterDraftUpdateAppended,
    }),
    liveCoordinator: deps.liveCoordinator,
    lifecycle: deps.lifecycle ?? createNoopDraftDocumentLifecycle(),
    draftStore: deps.draftStore,
    syncStateStore: createDrizzleDraftSyncStateStore(deps.db, { draftStore: deps.draftStore }),
    eventSink: deps.eventSink,
    draftFence,
  });
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
  const draftWriteRouter = createDraftWriteModeRouter({
    liveUtilityCore,
    createDraftCore:
      deps.createDraftSessionCore ??
      (() => {
        throw new Error("Draft-mode response writes require a draft session core factory");
      }),
    resolveThreadWorkId: deps.draftStore.resolveWorkId,
    resolveWorkWriteMode: deps.resolveWorkWriteMode ?? (async () => "direct"),
    threads: deps.threads,
    markDraftCreatedDocument: deps.draftStore.markDraftCreatedDocument,
    discardFailedResponseDrafts: deps.draftStore.discardFailedResponseDrafts,
    refreshLiveProjection: ({ documentId, threadId }) =>
      refreshDocumentProjection(documentId, threadId, "collab.response_finalize"),
  });
  const agentEditCore = draftWriteRouter.agentEditCore;
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
    liveUpdateJournal: deps.journal,
    latestLiveUpdateSeq: deps.store.latestUpdateSeq,
    liveCoordinator: deps.coordinator,
    model,
    codec,
    invalidateInFlight: draftWriteRouter.invalidateDraft,
    drainDraftRoomPersistence: (draftId) =>
      hocuspocusPersistence.drainHocuspocusDraftPersistence(draftId),
    closeDraftRoom: (draftId) => hocuspocusPersistence.closeHocuspocusDraftRoom(draftId),
    refreshAcceptedProjection: ({ documentId, threadId }) =>
      refreshDocumentProjection(documentId, threadId, "collab.draft_accept"),
    reverseTurn: async ({ documentId, threadId, turnId, userId }) => {
      const result = await agentEditCore.reverse({
        docId: documentId,
        threadId,
        direction: "undo",
        selection: { kind: "turn", turnId },
        actor: { type: "user", userId },
      });
      return result.status === "success" ? "reversed" : "not_reversed";
    },
  });
  const draftReviewQueries = createDraftReviewQueries({
    journal: deps.journal,
    draftStore: deps.draftStore,
    liveSeqStore: deps.store,
    codec,
    model,
  });
  const draftService = {
    ...draftLifecycle,
    ...draftReviewQueries,
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

  const checkpoints = createCheckpointService({
    coordinator: deps.coordinator,
    store: deps.store,
    latestUpdateSeq,
    markdownDocuments,
  });
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal: deps.journal,
    draftStore: deps.draftStore,
    hocuspocus: deps.hocuspocus,
    eventSink: deps.eventSink,
    metaForOrigin,
    latestUpdateSeq,
    emitAgentEditInvariantViolation,
  });

  const draftServiceWithRouter = {
    ...draftService,
    countInFlightDraftSessionsByWork: draftWriteRouter.countInFlightDraftSessionsByWork,
  };

  return {
    agentEdit() {
      return agentEditCore;
    },

    drafts: draftServiceWithRouter,

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
      return deps.liveLineage.listLiveDocumentsForTurn(threadId, turnId);
    },

    resolveThreadWriteMode(threadId) {
      return draftWriteRouter.resolveThreadWriteMode(threadId);
    },

    finalizeResponseCommit: draftWriteRouter.finalizeResponseCommit,

    finalizeResponseRollback: draftWriteRouter.finalizeResponseRollback,

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

    resolveDraftHocuspocusRoom: hocuspocusPersistence.resolveDraftHocuspocusRoom,

    loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,

    loadHocuspocusDraft: hocuspocusPersistence.loadHocuspocusDraft,

    persistConnectionUpdate: hocuspocusPersistence.persistConnectionUpdate,

    persistDraftConnectionUpdate: hocuspocusPersistence.persistDraftConnectionUpdate,

    storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,

    storeHocuspocusDraft: hocuspocusPersistence.storeHocuspocusDraft,

    drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,

    drainHocuspocusDraftPersistence: hocuspocusPersistence.drainHocuspocusDraftPersistence,

    closeHocuspocusDraftRoom: hocuspocusPersistence.closeHocuspocusDraftRoom,

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
    latestUpdateSeq: (docId) => journal.latestUpdateSeq(docId),
  };
}

function createInMemoryTurnLiveLineageStore(
  journal: InMemoryJournal,
): TurnLiveLineageDocumentStore {
  return {
    async listLiveDocumentIdsForTurn(threadId, turnId) {
      return (await journal.documentsForTurn(threadId, turnId)) as DocumentId[];
    },
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
