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
  toDocHandle,
  type UndoNotificationPort,
  type UpdateJournal,
  type UpdateMeta,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { draftRoomName } from "@meridian/contracts/protocol";
import type {
  DocumentId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
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
import { runAfterDrizzleCommit } from "../../shared/drizzle-transaction.js";
import { Ok } from "../../shared/result.js";
import {
  createDocumentUriResolver,
  type DocumentUriResolver,
} from "../context/document-uri-resolver.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { PendingUndoNotificationRepository } from "../undo-notifications/index.js";
import { createDrizzleBranchPushStore } from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleDraftAcceptJournal } from "./adapters/drizzle-draft-accept-journal.js";
import {
  createDraftProjectionDocumentCoordinator,
  createDraftSessionFence,
  createDrizzleDraftAgentEditJournal,
  createDrizzleDraftSyncStateStore,
  type DraftSessionFence,
} from "./adapters/drizzle-draft-agent-edit.js";
import { createDrizzleDraftStore } from "./adapters/drizzle-drafts.js";
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
import {
  createBranchAgentEditCoordinator,
  createBranchAgentEditJournal,
  createBranchConcurrentJournalWatermarks,
  createBranchPendingJournalEntries,
} from "./domain/branch-agent-edit.js";
import { createBranchCoordinator } from "./domain/branch-coordinator.js";
import { createBranchPullService } from "./domain/branch-pulls.js";
import {
  type BranchPushService,
  type BranchPushStore,
  createBranchPushService,
} from "./domain/branch-push.js";
import { BranchCorruptError, BranchNotFoundError } from "./domain/branch-resolver.js";
import { touchDocumentActivity, updateMarkdownProjection } from "./domain/document-activity.js";
import { computeDraftReviewHunks } from "./domain/draft-review-hunks.js";
import {
  createDraftService,
  type Draft,
  type DraftAcceptJournal,
  type DraftStore,
} from "./domain/drafts.js";
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
import { closeBranchRooms } from "./hocuspocus-rooms.js";
import type { CollabDomain, DocumentWriteHook, WriteMode } from "./index.js";

export type { DocumentWriteHook } from "./index.js";

type CollabDomainDeps = {
  db: Database;
  threads: {
    findById(threadId: ThreadId): Promise<unknown>;
  };
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

type ThreadModeRepository = {
  findById(threadId: ThreadId): Promise<unknown>;
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
  branchStore?: ReturnType<typeof createDrizzleBranchStore>;
  branchCoordinator?: ReturnType<typeof createBranchCoordinator>;
  branchPulls?: ReturnType<typeof createBranchPullService>;
  branchPush?: BranchPushService;
  branchPushStore?: BranchPushStore;
  concurrentJournalWatermarks?: ReturnType<typeof createBranchConcurrentJournalWatermarks>;
  manifestMembership?: {
    resolveManifestMembership(input: {
      projectId: ProjectId;
      workId?: WorkId | null;
      threadId?: ThreadId | null;
    }): Promise<{ documentId: DocumentId; members: string[] }>;
    recordManifestDocumentCreated(
      documentId: DocumentId,
      view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
    ): Promise<{ workDraftBranchId?: string; policy?: "manual" | "auto" } | undefined>;
    recordManifestDocumentDeleted(
      documentId: DocumentId,
      view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
    ): Promise<{ workDraftBranchId?: string; policy?: "manual" | "auto" } | undefined>;
  };
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
      const writeHandleTurns = input.writeHandleTurns.filter(
        (entry): entry is { writeHandle: string; turnId: string } => entry.turnId !== null,
      );
      if (writeHandleTurns.length === 0) return;
      await deps.repository.record({
        threadId: input.threadId,
        writeHandles: input.writeHandles,
        writeHandleTurns,
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
  const branchRoomPrefix = (branchId: string) => `branch:${branchId}:gen:`;
  const closeBranchRoom = (branchId: string) => closeBranchRooms(boundHocuspocus, branchId);
  const coordinator = createHocuspocusCoordinator({ hocuspocus, journal });
  const branchStore = createDrizzleBranchStore(deps.db, { journal, lifecycle, coordinator });
  const branchCoordinator = createBranchCoordinator({
    store: branchStore,
    onBranchUpdate({ branchId, update }) {
      try {
        for (const [roomName, branchDoc] of boundHocuspocus?.documents.entries() ?? []) {
          if (roomName.startsWith(branchRoomPrefix(branchId))) {
            Y.applyUpdate(branchDoc, update, DRAFT_AGENT_BROADCAST_ORIGIN);
          }
        }
      } catch (cause) {
        if (!deps.eventSink) return;
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "collab.branch_review",
          name: "branch_update_broadcast.failed",
          payload: { branchId, ...unknownToEventPayload(cause) },
        });
      }
    },
    onBranchReset({ branchId }) {
      closeBranchRoom(branchId);
    },
  });
  const concurrentJournalWatermarks = createBranchConcurrentJournalWatermarks();
  const branchPulls = createBranchPullService({
    liveCoordinator: coordinator,
    branchCoordinator,
    branches: branchStore,
    concurrentJournalWatermarks,
  });
  const branchPushStore = createDrizzleBranchPushStore(deps.db, {
    model: yProsemirrorModel(buildDocumentSchema()),
    codec: mdxCodec({ schema: buildDocumentSchema() }),
  });
  const branchPush = createBranchPushService({
    branchStore,
    pushStore: branchPushStore,
    branchCoordinator,
    journal,
    liveCoordinator: coordinator,
    model: yProsemirrorModel(buildDocumentSchema()),
    codec: mdxCodec({ schema: buildDocumentSchema() }),
  });

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
    branchStore,
    branchCoordinator,
    branchPulls,
    branchPush,
    concurrentJournalWatermarks,
    branchPushStore,
    manifestMembership: branchStore,
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
        liveUpdateJournal: journal,
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
    draftAcceptJournal: createInMemoryDraftAcceptJournal(journal, draftStore.getDraft),
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
      liveUpdateJournal: deps.journal,
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
    // Draft sessions do not emit model-facing undo notifications. Turn reversal is
    // user-driven through /context/reverse, not a follow-up instruction to the agent.
    onInvariantViolation: agentEditInvariantPolicy(deps.eventSink),
    onBaselineDegraded: agentEditBaselineDegradationObserver(deps.eventSink),
  });
}

export function createDrizzleDraftSessionCore(deps: {
  db: Database;
  threadId: ThreadId;
  liveCoordinator: DocumentCoordinator;
  liveUpdateJournal?: Pick<UpdateJournal, "read">;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  draftStore: DraftStore;
  latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number>;
  afterDraftUpdateAppended?: (input: { draftId: string; update: Uint8Array }) => void;
  eventSink?: EventSink;
}): AgentEditCore {
  const draftFence = createDraftSessionFence();
  return Object.assign(
    createDraftSessionCore({
      threadId: deps.threadId,
      journal: createDrizzleDraftAgentEditJournal(deps.db, {
        threadId: deps.threadId,
        draftFence,
        latestLiveUpdateSeq: deps.latestLiveUpdateSeq,
        liveUpdateJournal: deps.liveUpdateJournal,
        draftStore: deps.draftStore,
        afterDraftUpdateAppended: deps.afterDraftUpdateAppended,
      }),
      liveCoordinator: deps.liveCoordinator,
      lifecycle: deps.lifecycle,
      draftStore: deps.draftStore,
      syncStateStore: createDrizzleDraftSyncStateStore(deps.db, { draftStore: deps.draftStore }),
      eventSink: deps.eventSink,
      draftFence,
    }),
    { draftFence },
  );
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
      onBaselineDegraded: agentEditBaselineDegradationObserver(deps.eventSink),
    });
  const liveUtilityCore: AgentEditCore = createLiveCore();
  const branchAgentEdit =
    deps.branchStore && deps.branchCoordinator
      ? { store: deps.branchStore, coordinator: deps.branchCoordinator }
      : null;
  const agentEditCore = branchAgentEdit
    ? createThreadPeerAgentEditCore({
        liveUtilityCore,
        createThreadCore: (threadId) => {
          const pendingJournalEntries = createBranchPendingJournalEntries();
          return createAgentEditCore({
            journal: createBranchAgentEditJournal({
              threadId,
              liveJournal: deps.journal,
              pendingJournalEntries,
            }),
            coordinator: createBranchAgentEditCoordinator({
              threadId,
              liveCoordinator: deps.coordinator,
              branchCoordinator: branchAgentEdit.coordinator,
              branches: branchAgentEdit.store,
              pendingJournalEntries,
              branchPush: deps.branchPush,
              journalRows: deps.branchPushStore,
              eventSink: deps.eventSink,
              model,
              codec,
              concurrentJournalWatermarks: deps.concurrentJournalWatermarks,
            }),
            lifecycle: deps.lifecycle,
            codec,
            model,
            defaultThreadId: threadId,
            undoClientId: AGENT_EDIT_UNDO_CLIENT_ID,
            createRuntimeDoc: () => createCollabYDoc({ gc: false }),
            syncStateStore: deps.syncStateStore,
            onInvariantViolation: agentEditInvariantPolicy(deps.eventSink),
            onBaselineDegraded: agentEditBaselineDegradationObserver(deps.eventSink),
          });
        },
        syncStateStore: deps.syncStateStore,
        discardThreadPeerBranches: async (documentId, threadId) => {
          await deps.branchStore?.discardActiveThreadPeerBranches({
            documentId,
            threadId: threadId ? (threadId as ThreadId) : null,
          });
        },
        beforeThreadInteraction: deps.branchPulls
          ? async ({ documentId, threadId }) =>
              deps.branchPulls?.pullThreadPeer({ documentId, threadId })
          : undefined,
      })
    : liveUtilityCore;
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
    invalidateInFlight: async () => {},
    drainDraftRoomPersistence: (draftId) =>
      hocuspocusPersistence.drainHocuspocusDraftPersistence(draftId),
    closeDraftRoom: (draftId) => hocuspocusPersistence.closeHocuspocusDraftRoom(draftId),
    countInFlightDraftSessionsByWork: () => 0,
    refreshAcceptedProjection: ({ documentId, threadId }) =>
      refreshDocumentProjection(documentId, threadId, "collab.draft_accept"),
    reverseAcceptedDraft: async ({ documentId, threadId, writeId, userId }) => {
      const result = await agentEditCore.reverse({
        docId: documentId,
        threadId,
        direction: "undo",
        selection: { kind: "single", to: writeId },
        actor: { type: "user", userId },
        requireEffect: true,
      });
      if (
        result.status !== "success" &&
        result.status !== "reversed" &&
        result.status !== "reconciled"
      ) {
        return "not_reversed";
      }
      return "reversalEffect" in result && result.reversalEffect === "changed"
        ? "reversed"
        : "not_reversed";
    },
  });
  async function requireDraftThreadForWork(input: {
    workId?: WorkId;
    threadId?: ThreadId;
    documentId: DocumentId;
    draftId: string;
  }): Promise<ThreadId> {
    if (input.threadId) return input.threadId;
    if (!input.workId) throw new Error("draft_not_found");
    const draft = await draftLifecycle.getDraft(input.draftId);
    if (!draft || draft.workId !== input.workId || draft.documentId !== input.documentId) {
      throw new Error("draft_not_found");
    }
    const threadId =
      (await draftLifecycle.resolvePrimaryThreadForWork(input.workId)) ??
      (await draftLifecycle.resolveDraftThreadId(input.draftId));
    if (!threadId) throw new Error("draft_not_found");
    return threadId;
  }

  function isActiveDraftForDocument(
    draft: Draft | null,
    documentId: string,
  ): draft is Draft & { status: "active" } {
    return draft?.status === "active" && draft.documentId === documentId;
  }

  function requireInputThreadId(input: { threadId?: ThreadId }): ThreadId {
    if (!input.threadId) throw new Error("draft_not_found");
    return input.threadId;
  }

  async function previewWorkDraftBranch(input: { documentId: DocumentId; workId: WorkId }) {
    if (!deps.branchStore || !deps.branchCoordinator || !deps.branchPushStore) return null;
    const liveState = await deps.coordinator.withDocument(input.documentId, async (liveDoc) => ({
      state: Y.encodeStateAsUpdate(liveDoc),
      markdown: markdownDocuments.serializeDoc(liveDoc),
    }));
    const liveDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(liveDoc, liveState.state);
    let notice: { code: "branch_corrupt_reset"; message: string } | undefined;
    try {
      let branch: { branchId: string; generation: number; doc: Y.Doc };
      try {
        // §6.1 review entry is explicitly read-or-create: a missing work-draft row
        // is created from live so the writer can always enter an empty review room.
        branch = await deps.branchStore.resolveWorkDraftBranchForWork({
          documentId: input.documentId,
          workId: input.workId,
          liveDoc,
        });
      } catch (cause) {
        if (!(cause instanceof BranchCorruptError)) throw cause;
        const corrupt = await deps.branchStore.getBranch(cause.branchId);
        if (corrupt?.kind !== "work_draft" || corrupt.status !== "active") throw cause;
        await deps.branchCoordinator.resetFromDoc(corrupt.branchId, liveDoc);
        await agentEditCore.invalidateThread(input.documentId, "");
        notice = {
          code: "branch_corrupt_reset",
          message: "Review state was repaired from the live document.",
        };
        branch = await deps.branchStore.resolveWorkDraftBranchForWork({
          documentId: input.documentId,
          workId: input.workId,
          liveDoc,
        });
      }
      try {
        const draftUpdates = (
          await deps.branchPushStore.listActiveJournalRows(branch.branchId, branch.generation)
        ).map((row) => ({
          id: row.id,
          actorTurnId: row.turnId,
          actorUserId: row.actorUserId,
          updateData: row.updateData,
          updateKind: row.source,
        }));
        const review = computeDraftReviewHunks({
          liveDoc,
          draftDoc: branch.doc,
          model,
          draftUpdates,
        });
        return {
          status: "active" as const,
          branchId: branch.branchId,
          live: liveState.markdown,
          markdown: markdownDocuments.serializeDoc(branch.doc),
          liveRevisionToken: await latestUpdateSeq(input.documentId),
          draftRevisionToken: branch.generation,
          inlineModelPresent: true as const,
          operations: review.operations,
          hunks: review.hunks,
          ...(notice ? { notice } : {}),
        };
      } finally {
        branch.doc.destroy();
      }
    } finally {
      liveDoc.destroy();
    }
  }

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
    branchStore: deps.branchStore,
    branchCoordinator: deps.branchCoordinator,
    hocuspocus: deps.hocuspocus,
    eventSink: deps.eventSink,
    metaForOrigin,
    latestUpdateSeq,
    emitAgentEditInvariantViolation,
    onLiveUpdatePersisted: deps.branchPulls?.scheduleLivePull,
  });

  function readWithStagedResponseOverlay<T>(
    doc: Y.Doc,
    input: { documentId: DocumentId; responseId?: string | null },
    read: (doc: Y.Doc) => T,
  ): T {
    if (!input.responseId) return read(doc);
    const updates = agentEditCore.bufferedUpdatesForDoc(input.responseId, input.documentId);
    if (updates.length === 0) return read(doc);
    const effective = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(effective, Y.encodeStateAsUpdate(doc), { type: "system" });
      for (const update of updates) Y.applyUpdate(effective, update, { type: "system" });
      return read(effective);
    } finally {
      effective.destroy();
    }
  }

  function readStagedResponseOnly<T>(
    input: { documentId: DocumentId; responseId?: string | null },
    read: (doc: Y.Doc) => T,
  ): T | null {
    if (!input.responseId) return null;
    const updates = agentEditCore.bufferedUpdatesForDoc(input.responseId, input.documentId);
    if (updates.length === 0) return null;
    const doc = createCollabYDoc({ gc: false });
    try {
      for (const update of updates) Y.applyUpdate(doc, update, { type: "system" });
      return read(doc);
    } finally {
      doc.destroy();
    }
  }

  return {
    agentEdit() {
      return agentEditCore;
    },

    draftReview: {
      list: (input) =>
        input.workId
          ? draftLifecycle.listReviewableDraftsByWork({ workId: input.workId })
          : draftLifecycle.listReviewableDrafts({ threadId: requireInputThreadId(input) }),
      async preview(input) {
        if (input.workId) {
          const branchPreview = await previewWorkDraftBranch({
            documentId: input.documentId,
            workId: input.workId,
          });
          if (branchPreview) return branchPreview;
        }
        const live = await markdownDocuments.readAsMarkdown(input.documentId);
        if (!live.ok) throw new Error(`read_failed:${live.error.code}`);
        const draft = input.workId
          ? await draftLifecycle.getActiveDraftByWork({
              documentId: input.documentId,
              workId: input.workId,
            })
          : input.draftId
            ? await draftLifecycle.getDraft(input.draftId)
            : null;
        if (!isActiveDraftForDocument(draft, input.documentId)) {
          return { status: "gone", live: live.value };
        }
        return {
          status: "active",
          draftId: draft.id,
          ...(await draftLifecycle.previewDraft({
            documentId: input.documentId,
            draftId: draft.id,
          })),
        };
      },
      async journal(input) {
        const draft = input.workId
          ? await draftLifecycle.getActiveDraftByWork({
              documentId: input.documentId,
              workId: input.workId,
            })
          : input.draftId
            ? await draftLifecycle.getDraft(input.draftId)
            : null;
        if (!isActiveDraftForDocument(draft, input.documentId) || draft.id !== input.draftId) {
          return { status: "not_found" };
        }
        return draftLifecycle.getDraftJournal({
          documentId: input.documentId,
          draftId: input.draftId,
        });
      },
      async accept(input) {
        if (input.workId && deps.branchStore && deps.branchPush) {
          const branch = input.branchId ? await deps.branchStore.getBranch(input.branchId) : null;
          if (
            branch?.kind === "work_draft" &&
            branch.status === "active" &&
            branch.workId === input.workId &&
            branch.documentId === input.documentId
          ) {
            if (
              (input.operationIds?.length ?? 0) > 0 ||
              input.confirmOverlap === true ||
              input.confirmedLiveRevisionToken !== undefined ||
              (input.confirmedClosureOperationIds?.length ?? 0) > 0
            ) {
              throw new Error("branch_partial_accept_unsupported");
            }
            if (
              input.draftRevisionToken !== undefined &&
              input.draftRevisionToken !== branch.generation
            ) {
              return {
                status: "stale_draft" as const,
                draftId: branch.branchId,
                draftRevisionToken: branch.generation,
              };
            }
            if (input.projectId) {
              const manifest = await deps.branchStore.ensureProjectManifest({
                projectId: input.projectId,
              });
              try {
                const manifestBranch = await deps.branchStore.resolveWorkDraftBranchForWork({
                  documentId: manifest.documentId,
                  workId: input.workId,
                  liveDoc: manifest.doc,
                });
                try {
                  await deps.branchPush.pushToLiveWithManifestEntry({
                    branchId: branch.branchId,
                    manifestBranchId: manifestBranch.branchId,
                    manifestEntryDocumentId: input.documentId,
                    pushedByUserId: input.userId,
                  });
                } finally {
                  manifestBranch.doc.destroy();
                }
              } finally {
                manifest.doc.destroy();
              }
            } else {
              await deps.branchPush.pushToLive({
                branchId: branch.branchId,
                pushedByUserId: input.userId,
              });
            }
            return {
              status: "applied" as const,
              draftId: branch.branchId,
              branchId: branch.branchId,
              appliedUpdateSeq: 0,
            };
          }
        }
        if (!input.draftId) throw new Error("draft_not_found");
        return draftLifecycle.acceptDraft({
          documentId: input.documentId,
          draftId: input.draftId,
          userId: input.userId,
          confirmOverlap: input.confirmOverlap,
          confirmedLiveRevisionToken: input.confirmedLiveRevisionToken,
          draftRevisionToken: input.draftRevisionToken,
          operationIds: input.operationIds,
          confirmedClosureOperationIds: input.confirmedClosureOperationIds,
          threadId: await requireDraftThreadForWork({
            workId: input.workId,
            threadId: input.threadId,
            documentId: input.documentId,
            draftId: input.draftId,
          }),
        });
      },
      async reject(input) {
        if (input.workId && deps.branchStore && deps.branchCoordinator) {
          const branch = input.branchId ? await deps.branchStore.getBranch(input.branchId) : null;
          if (
            branch?.kind === "work_draft" &&
            branch.status === "active" &&
            branch.workId === input.workId &&
            branch.documentId === input.documentId
          ) {
            await deps.coordinator.withDocument(input.documentId, async (liveDoc) =>
              deps.branchCoordinator?.resetFromDoc(branch.branchId, liveDoc),
            );
            await agentEditCore.invalidateThread(input.documentId, input.threadId ?? "");
            return {
              status: "discarded" as const,
              draftId: branch.branchId,
              branchId: branch.branchId,
            };
          }
        }
        if (!input.draftId) throw new Error("draft_not_found");
        return draftLifecycle.rejectDraft({
          documentId: input.documentId,
          draftId: input.draftId,
          threadId: await requireDraftThreadForWork({
            workId: input.workId,
            threadId: input.threadId,
            documentId: input.documentId,
            draftId: input.draftId,
          }),
        });
      },
      async undoAccept(input) {
        return draftLifecycle.undoAcceptDraft({
          ...input,
          threadId: await requireDraftThreadForWork(input),
        });
      },
      async undoReject(input) {
        return draftLifecycle.undoRejectDraft({
          ...input,
          threadId: await requireDraftThreadForWork(input),
        });
      },
    },

    draftLifecycleFeed: {
      listLifecycleStateByWork: draftLifecycle.listLifecycleStateByWork,
    },

    draftSessionStats: {
      countInFlightDraftSessionsByWork: draftLifecycle.countInFlightDraftSessionsByWork,
      listActiveDraftsByWork: draftLifecycle.listActiveDraftsByWork,
    },

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

    listEditedDocumentsForTurn(threadId, turnId) {
      return deps.liveLineage.listEditedDocumentsForTurn(threadId, turnId);
    },

    async finalizeResponseCommit(responseId, ctx) {
      const result = await agentEditCore.commitResponse(responseId);
      for (const document of result.documents) {
        if (deps.branchStore && deps.branchCoordinator) {
          const peer = await deps.branchStore.resolveThreadBranch(
            document.documentId as DocumentId,
            ctx.threadId,
          );
          try {
            // Thread peers push every write durably into the work draft; their own
            // snapshot is only a recovery checkpoint and is therefore persisted at
            // commitResponse, not on every coordinator mutation.
            await deps.branchCoordinator.checkpointBranch(peer.branchId);
          } finally {
            peer.doc.destroy();
          }
        }
        await refreshDocumentProjection(
          document.documentId as DocumentId,
          ctx.threadId,
          "collab.response_finalize",
        );
      }
      return { documents: result.documents, stagedCreates: result.stagedCreates };
    },

    async finalizeResponseRollback(responseId) {
      const result = await agentEditCore.rollbackResponse(responseId);
      return { stagedCreates: result.stagedCreates };
    },

    async writeFromMarkdown(documentId, markdown, origin) {
      return markdownDocuments.writeFromMarkdown(documentId, markdown, origin);
    },

    reverseTurn(input) {
      return reverseTurnAcrossDocuments(
        {
          reversalStore: deps.journal,
          agentEdit: agentEditCore,
          draftAgentEdit: (threadId) => deps.createDraftSessionCore?.({ threadId }) ?? null,
          resolveDocumentUri: deps.documentUriResolver ?? (async (documentId) => documentId),
          refreshDocumentProjection: (projection) =>
            refreshDocumentProjection(projection.documentId, projection.threadId),
          refreshDraftProjection: async ({ documentId, threadId }) => {
            const draft = await deps.draftStore.getActiveDraft({ documentId, threadId });
            if (draft)
              await draftLifecycle.refreshDraftWordDelta({ documentId, draftId: draft.id });
          },
          undoAcceptedDraft: ({ documentId, threadId, draftId, writeId, userId }) =>
            draftLifecycle.undoAcceptDraft({ documentId, threadId, draftId, writeId, userId }),
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

    pushToLive(input) {
      if (!deps.branchPush) throw new Error("Branch push service is not configured");
      return deps.branchPush.pushToLive(input);
    },

    setWorkPushPolicy(input) {
      if (!deps.branchPush) throw new Error("Branch push service is not configured");
      return deps.branchPush.setWorkPushPolicy(input);
    },

    markFailedResponseRollbackPending(input) {
      if (!deps.branchPush) throw new Error("Branch push service is not configured");
      return deps.branchPush.markFailedResponseRollbackPending(input);
    },

    pullThreadPeer(input) {
      if (!deps.branchPulls) return Promise.resolve();
      return deps.branchPulls.pullThreadPeer(input);
    },

    flushBranchLivePull(documentId) {
      if (!deps.branchPulls) return Promise.resolve();
      return deps.branchPulls.flushLivePull(documentId);
    },

    async readEffectiveMarkdown(input) {
      if (input.threadId && deps.branchStore) {
        const isStagedOnlyCreatedDocument = Boolean(
          input.responseId &&
            agentEditCore
              .stagedCreatedDocumentIds(input.responseId, input.threadId)
              .includes(input.documentId),
        );
        if (isStagedOnlyCreatedDocument) {
          const stagedOnly = readStagedResponseOnly(input, markdownDocuments.serializeDoc);
          if (stagedOnly !== null) return Ok(stagedOnly);
        }
        if (deps.branchPulls) {
          try {
            const existingPeer = await deps.branchStore.resolveThreadBranch(
              input.documentId,
              input.threadId,
            );
            existingPeer.doc.destroy();
            await deps.branchPulls.pullThreadPeer({
              documentId: input.documentId,
              threadId: input.threadId,
            });
          } catch (cause) {
            if (!(cause instanceof BranchNotFoundError)) throw cause;
          }
        }
        try {
          const branch = await deps.branchStore.resolveThreadBranch(
            input.documentId,
            input.threadId,
          );
          try {
            if (deps.branchCoordinator) {
              return Ok(
                await deps.branchCoordinator.readBranch(branch.branchId, async (doc) =>
                  readWithStagedResponseOverlay(doc, input, markdownDocuments.serializeDoc),
                ),
              );
            }
            return Ok(
              readWithStagedResponseOverlay(branch.doc, input, markdownDocuments.serializeDoc),
            );
          } finally {
            branch.doc.destroy();
          }
        } catch (cause) {
          if (!(cause instanceof BranchNotFoundError)) throw cause;
        }
        try {
          const workDraft = await deps.branchStore.resolveWorkDraftBranchForThread(
            input.documentId,
            input.threadId,
          );
          try {
            if (deps.branchCoordinator) {
              return Ok(
                await deps.branchCoordinator.readBranch(workDraft.branchId, async (doc) =>
                  readWithStagedResponseOverlay(doc, input, markdownDocuments.serializeDoc),
                ),
              );
            }
            return Ok(
              readWithStagedResponseOverlay(workDraft.doc, input, markdownDocuments.serializeDoc),
            );
          } finally {
            workDraft.doc.destroy();
          }
        } catch (cause) {
          if (!(cause instanceof BranchNotFoundError)) throw cause;
        }
        const stagedOnly = readStagedResponseOnly(input, markdownDocuments.serializeDoc);
        if (stagedOnly !== null) return Ok(stagedOnly);
      }
      return markdownDocuments.readAsMarkdown(input.documentId);
    },

    async readEffectiveHashlines(input) {
      if (input.threadId && deps.branchStore) {
        const isStagedOnlyCreatedDocument = Boolean(
          input.responseId &&
            agentEditCore
              .stagedCreatedDocumentIds(input.responseId, input.threadId)
              .includes(input.documentId),
        );
        if (isStagedOnlyCreatedDocument) {
          const stagedOnly = readStagedResponseOnly(input, (doc) =>
            model.serializeBlockLines(toDocHandle(doc), codec),
          );
          if (stagedOnly !== null) return Ok(stagedOnly);
        }
        if (deps.branchPulls) {
          try {
            const existingPeer = await deps.branchStore.resolveThreadBranch(
              input.documentId,
              input.threadId,
            );
            existingPeer.doc.destroy();
            await deps.branchPulls.pullThreadPeer({
              documentId: input.documentId,
              threadId: input.threadId,
            });
          } catch (cause) {
            if (!(cause instanceof BranchNotFoundError)) throw cause;
          }
        }
        try {
          const branch = await deps.branchStore.resolveThreadBranch(
            input.documentId,
            input.threadId,
          );
          try {
            if (deps.branchCoordinator) {
              return Ok(
                await deps.branchCoordinator.readBranch(branch.branchId, async (doc) =>
                  readWithStagedResponseOverlay(doc, input, (effective) =>
                    model.serializeBlockLines(toDocHandle(effective), codec),
                  ),
                ),
              );
            }
            return Ok(
              readWithStagedResponseOverlay(branch.doc, input, (effective) =>
                model.serializeBlockLines(toDocHandle(effective), codec),
              ),
            );
          } finally {
            branch.doc.destroy();
          }
        } catch (cause) {
          if (!(cause instanceof BranchNotFoundError)) throw cause;
        }
        try {
          const workDraft = await deps.branchStore.resolveWorkDraftBranchForThread(
            input.documentId,
            input.threadId,
          );
          try {
            if (deps.branchCoordinator) {
              return Ok(
                await deps.branchCoordinator.readBranch(workDraft.branchId, async (doc) =>
                  readWithStagedResponseOverlay(doc, input, (effective) =>
                    model.serializeBlockLines(toDocHandle(effective), codec),
                  ),
                ),
              );
            }
            return Ok(
              readWithStagedResponseOverlay(workDraft.doc, input, (effective) =>
                model.serializeBlockLines(toDocHandle(effective), codec),
              ),
            );
          } finally {
            workDraft.doc.destroy();
          }
        } catch (cause) {
          if (!(cause instanceof BranchNotFoundError)) throw cause;
        }
        const stagedOnly = readStagedResponseOnly(input, (doc) =>
          model.serializeBlockLines(toDocHandle(doc), codec),
        );
        if (stagedOnly !== null) return Ok(stagedOnly);
      }
      return deps.coordinator.withDocument(input.documentId, async (doc) =>
        Ok(model.serializeBlockLines(toDocHandle(doc), codec)),
      );
    },

    async resolveManifestMembership(input) {
      if (!deps.manifestMembership) return { documentId: "" as DocumentId, members: [] };
      if (deps.branchStore && deps.branchPulls) {
        const manifest = await deps.branchStore.ensureProjectManifest({
          projectId: input.projectId,
        });
        try {
          if (input.threadId) {
            await deps.branchPulls.pullThreadPeer({
              documentId: manifest.documentId,
              threadId: input.threadId,
            });
          } else if (input.workId) {
            await deps.branchPulls.flushLivePull(manifest.documentId);
          }
        } finally {
          manifest.doc.destroy();
        }
      }
      const membership = await deps.manifestMembership.resolveManifestMembership(input);
      if (!input.responseId || !input.threadId) return membership;
      return {
        ...membership,
        members: [
          ...new Set([
            ...membership.members,
            ...agentEditCore.stagedCreatedDocumentIds(input.responseId, input.threadId),
          ]),
        ],
      };
    },

    async recordManifestDocumentCreated(documentId, view) {
      if (!deps.manifestMembership) return;
      const mutation = await deps.manifestMembership.recordManifestDocumentCreated(
        documentId,
        view,
      );
      if (mutation?.workDraftBranchId && deps.branchPush) {
        await deps.branchPush.pushAutoBranchAfterThreadPeerWrite({
          workDraftBranchId: mutation.workDraftBranchId,
        });
      }
    },

    async recordManifestDocumentDeleted(documentId, view) {
      if (!deps.manifestMembership) return;
      const mutation = await deps.manifestMembership.recordManifestDocumentDeleted(
        documentId,
        view,
      );
      if (mutation?.workDraftBranchId && deps.branchPush) {
        await deps.branchPush.pushAutoBranchAfterThreadPeerWrite({
          workDraftBranchId: mutation.workDraftBranchId,
        });
      }
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

    resolveBranchHocuspocusRoom: hocuspocusPersistence.resolveBranchHocuspocusRoom,

    loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,

    loadHocuspocusDraft: hocuspocusPersistence.loadHocuspocusDraft,

    loadHocuspocusBranchState: hocuspocusPersistence.loadHocuspocusBranchState,

    persistConnectionUpdate: hocuspocusPersistence.persistConnectionUpdate,

    persistDraftConnectionUpdate: hocuspocusPersistence.persistDraftConnectionUpdate,

    persistBranchConnectionUpdate: hocuspocusPersistence.persistBranchConnectionUpdate,

    storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,

    storeHocuspocusDraft: hocuspocusPersistence.storeHocuspocusDraft,

    storeHocuspocusBranch: hocuspocusPersistence.storeHocuspocusBranch,

    drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,

    drainHocuspocusDraftPersistence: hocuspocusPersistence.drainHocuspocusDraftPersistence,

    drainHocuspocusBranchPersistence: hocuspocusPersistence.drainHocuspocusBranchPersistence,

    closeHocuspocusDraftRoom: hocuspocusPersistence.closeHocuspocusDraftRoom,

    closeHocuspocusBranchRoom: hocuspocusPersistence.closeHocuspocusBranchRoom,

    rejectStaleBranchSyncStep1: hocuspocusPersistence.rejectStaleBranchSyncStep1,

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

export function createThreadPeerAgentEditCore(input: {
  liveUtilityCore: AgentEditCore;
  createThreadCore(threadId: ThreadId): AgentEditCore;
  syncStateStore?: SyncStateStore;
  discardThreadPeerBranches?(documentId: DocumentId, threadId: string): Promise<void>;
  beforeThreadInteraction?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<
    | {
        changed?: boolean;
        baselineSnapshot?: Uint8Array;
        branchGeneration?: number;
        afterJournalId?: number;
      }
    | undefined
  >;
  maxThreadCores?: number;
}): AgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  const activeResponseIds = new Map<ThreadId, Set<string>>();
  const pendingInteractionBaselines = new Map<
    string,
    { snapshot: Uint8Array; afterJournalId: number; branchGeneration?: number }
  >();
  const maxThreadCores = input.maxThreadCores ?? 128;

  function clearPendingBaselinesForThread(threadId: ThreadId, docId?: string): void {
    const prefix = `${threadId}\0`;
    for (const key of pendingInteractionBaselines.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (docId && key !== pendingBaselineKey(threadId, docId)) continue;
      pendingInteractionBaselines.delete(key);
    }
  }

  async function coreFor(threadId: string | undefined): Promise<AgentEditCore> {
    if (!threadId) return input.liveUtilityCore;
    const id = threadId as ThreadId;
    const existing = cores.get(id);
    if (existing) {
      cores.delete(id);
      cores.set(id, existing);
      return existing;
    }
    const core = input.createThreadCore(id);
    cores.set(id, core);
    await evictIdleCores();
    return core;
  }

  function coreForSync(threadId: string | undefined): AgentEditCore {
    if (!threadId) return input.liveUtilityCore;
    const id = threadId as ThreadId;
    const existing = cores.get(id);
    if (existing) return existing;
    const core = input.createThreadCore(id);
    cores.set(id, core);
    return core;
  }

  async function evictIdleCores(): Promise<void> {
    while (cores.size > maxThreadCores) {
      const oldest = [...cores.keys()].find((threadId) => !activeResponseIds.get(threadId)?.size);
      if (!oldest) break;
      await cores.get(oldest)?.invalidateThread("", oldest);
      cores.delete(oldest);
      activeResponseIds.delete(oldest);
      clearPendingBaselinesForThread(oldest);
    }
  }

  function trackResponse(threadId: string | undefined, responseId: string | undefined): void {
    if (!threadId || !responseId) return;
    const id = threadId as ThreadId;
    const active = activeResponseIds.get(id) ?? new Set<string>();
    active.add(responseId);
    activeResponseIds.set(id, active);
  }

  async function untrackResponse(responseId: string): Promise<void> {
    for (const [threadId, active] of activeResponseIds) {
      active.delete(responseId);
      if (active.size === 0) activeResponseIds.delete(threadId);
    }
    await evictIdleCores();
  }

  return {
    async write(command, context = {}) {
      trackResponse(context.threadId, context.responseId);
      const documentId = documentIdFromWriteCommand(command);
      const threadCore = await coreFor(context.threadId);
      let interactionBaselineSnapshot: Uint8Array | undefined;
      let usableBaselineFloor: number | undefined;
      let interactionBaselineBranchGeneration: number | undefined;
      const isResponseStagedOnlyDocument = Boolean(
        context.responseId &&
          context.threadId &&
          documentId &&
          threadCore
            .stagedCreatedDocumentIds(context.responseId, context.threadId)
            .includes(documentId),
      );
      const isResponseStagedCreate = Boolean(
        context.responseId && context.createdDocument && command.command === "create",
      );
      if (
        documentId &&
        context.threadId &&
        input.beforeThreadInteraction &&
        !isResponseStagedCreate &&
        !isResponseStagedOnlyDocument
      ) {
        const baselineKey = pendingBaselineKey(context.threadId, documentId);
        const pulled = await input.beforeThreadInteraction({
          documentId,
          threadId: context.threadId as ThreadId,
        });
        const pendingBaseline = pendingInteractionBaselines.get(baselineKey);
        const currentGeneration = pulled?.branchGeneration;
        const generationMatches =
          pendingBaseline &&
          (pendingBaseline.branchGeneration === undefined
            ? currentGeneration === undefined
            : pendingBaseline.branchGeneration === currentGeneration);
        if (pendingBaseline && !generationMatches) pendingInteractionBaselines.delete(baselineKey);
        const usablePending = generationMatches ? pendingBaseline : undefined;
        if (pulled?.changed && pulled.baselineSnapshot) {
          interactionBaselineSnapshot = usablePending?.snapshot ?? pulled.baselineSnapshot;
          usableBaselineFloor = usablePending?.afterJournalId ?? pulled.afterJournalId ?? 0;
          if (!usablePending) {
            pendingInteractionBaselines.set(baselineKey, {
              snapshot: pulled.baselineSnapshot,
              branchGeneration: currentGeneration,
              afterJournalId: pulled.afterJournalId ?? 0,
            });
          }
        } else {
          interactionBaselineSnapshot = usablePending?.snapshot;
          usableBaselineFloor = usablePending?.afterJournalId;
        }
        interactionBaselineBranchGeneration = usablePending?.branchGeneration ?? currentGeneration;
        if (!context.responseId && interactionBaselineSnapshot) {
          await threadCore.invalidateThread(documentId, context.threadId);
        }
      }
      const result = await threadCore.write(command, {
        ...context,
        ...(interactionBaselineSnapshot
          ? {
              interactionBaselineSnapshot,
              interactionBaselineAfterJournalId: usableBaselineFloor ?? 0,
              interactionBaselineBranchGeneration: interactionBaselineBranchGeneration,
            }
          : {}),
      });
      if (
        documentId &&
        context.threadId &&
        interactionBaselineSnapshot &&
        isSuccessfulAgentWrite(result)
      ) {
        const threadId = context.threadId;
        runAfterDrizzleCommit(() => {
          pendingInteractionBaselines.delete(pendingBaselineKey(threadId, documentId));
        });
      }
      return result;
    },
    recover(docId) {
      return Promise.all([...cores.values()].map((core) => core.recover(docId))).then(() => {});
    },
    async commitResponse(responseId) {
      const results = await Promise.all(
        [...cores.values()].map((core) => core.commitResponse(responseId)),
      );
      const combined = results.reduce(
        (combined, result) => ({
          responseId,
          documentCount: combined.documentCount + result.documentCount,
          updateCount: combined.updateCount + result.updateCount,
          documents: [...combined.documents, ...result.documents],
          stagedCreates: {
            committed: [...combined.stagedCreates.committed, ...result.stagedCreates.committed],
            discarded: [...combined.stagedCreates.discarded, ...result.stagedCreates.discarded],
          },
        }),
        {
          responseId,
          documentCount: 0,
          updateCount: 0,
          documents: [],
          stagedCreates: { committed: [], discarded: [] },
        } as Awaited<ReturnType<AgentEditCore["commitResponse"]>>,
      );
      await untrackResponse(responseId);
      return combined;
    },
    bufferedUpdatesForDoc(responseId, docId) {
      return [...cores.values()].flatMap((core) => core.bufferedUpdatesForDoc(responseId, docId));
    },
    stagedCreatedDocumentIds(responseId, threadId) {
      const targets = threadId ? [coreForSync(threadId)] : [...cores.values()];
      return targets.flatMap((core) => core.stagedCreatedDocumentIds(responseId, threadId));
    },
    async rollbackResponse(responseId) {
      const results = await Promise.all(
        [...cores.values()].map((core) => core.rollbackResponse(responseId)),
      );
      const combined = results.reduce(
        (combined, result) => ({
          responseId,
          stagedCreates: {
            committed: [...combined.stagedCreates.committed, ...result.stagedCreates.committed],
            discarded: [...combined.stagedCreates.discarded, ...result.stagedCreates.discarded],
          },
        }),
        {
          responseId,
          stagedCreates: { committed: [], discarded: [] },
        } as Awaited<ReturnType<AgentEditCore["rollbackResponse"]>>,
      );
      await untrackResponse(responseId);
      return combined;
    },
    async getAvailability(docId, threadId) {
      return (await coreFor(threadId)).getAvailability(docId, threadId);
    },
    async undo(docId, threadId) {
      return (await coreFor(threadId)).undo(docId, threadId);
    },
    async redo(docId, threadId) {
      return (await coreFor(threadId)).redo(docId, threadId);
    },
    async reverse(inputReverse) {
      return (await coreFor(inputReverse.threadId)).reverse(inputReverse);
    },
    async undoTurn(docId, threadId) {
      return (await coreFor(threadId)).undoTurn(docId, threadId);
    },
    async redoTurn(docId, threadId) {
      return (await coreFor(threadId)).redoTurn(docId, threadId);
    },
    async invalidateThread(docId, threadId) {
      if (docId && input.syncStateStore) {
        if (threadId) await input.syncStateStore.delete(docId, threadId);
        else await input.syncStateStore.deleteDocument(docId);
      }
      const errors: unknown[] = [];
      if (docId && input.discardThreadPeerBranches) {
        try {
          await input.discardThreadPeerBranches(docId as DocumentId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (threadId) {
        const id = threadId as ThreadId;
        try {
          await cores.get(id)?.invalidateThread(docId, threadId, { deleteSyncState: false });
        } catch (cause) {
          errors.push(cause);
        }
        cores.delete(id);
        activeResponseIds.delete(id);
        clearPendingBaselinesForThread(id, docId || undefined);
      } else {
        for (const [id, core] of [...cores]) {
          try {
            await core.invalidateThread(docId, id, { deleteSyncState: false });
          } catch (cause) {
            errors.push(cause);
          }
          cores.delete(id);
          activeResponseIds.delete(id);
          clearPendingBaselinesForThread(id, docId || undefined);
        }
        try {
          await input.liveUtilityCore.invalidateThread(docId, threadId, { deleteSyncState: false });
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Failed to invalidate all agent-edit runtimes");
    },
  };
}

function documentIdFromWriteCommand(command: unknown): DocumentId | null {
  if (typeof command !== "object" || command === null || !("documentId" in command)) return null;
  const documentId = (command as { documentId?: unknown }).documentId;
  return typeof documentId === "string" ? (documentId as DocumentId) : null;
}

function createInMemoryTurnLiveLineageStore(
  journal: InMemoryJournal,
): TurnLiveLineageDocumentStore {
  return {
    async listLiveDocumentIdsForTurn(threadId, turnId) {
      return (await journal.documentsForTurn(threadId, turnId)) as DocumentId[];
    },
    async listEditedDocumentIdsForTurn(threadId, turnId) {
      return (await journal.documentsForTurn(threadId, turnId)).map((documentId) => ({
        documentId: documentId as DocumentId,
        scope: "live" as const,
      }));
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

function pendingBaselineKey(threadId: string, documentId: string): string {
  return `${threadId}\0${documentId}`;
}

function isSuccessfulAgentWrite(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as { status?: unknown }).status === "success"
  );
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

function agentEditBaselineDegradationObserver(
  eventSink?: EventSink,
): (event: {
  documentId: string;
  responseId: string;
  from: "interaction";
  to: "preOwnSnapshot" | "committedSnapshot";
  reason: string;
}) => void {
  return (event) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "warn",
      source: "collab.agent_edit",
      name: "response_baseline.degraded",
      payload: event,
    });
  };
}
