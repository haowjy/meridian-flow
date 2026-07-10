/** Composition root for the server collab domain over @meridian/agent-edit. */
import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import {
  type AgentEditCore,
  createAgentEditCodec,
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentLifecycle,
  type PersistedUpdate as JournalUpdate,
  parseDocumentAddress,
  type ResponseLifecycleClaimDiscardedDetail,
  type ReversalNoticeFailedDetail,
  type ReversalNoticePort,
  type ReversalStore,
  toDocHandle,
  type UpdateJournal,
  type UpdateMeta,
  type WriteIdempotencyHitDetail,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import type { ReversalOutcome } from "@meridian/contracts/protocol";
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
import {
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { Ok, type Result } from "../../shared/result.js";
import {
  createDocumentUriResolver,
  type DocumentUriResolver,
} from "../context/document-uri-resolver.js";
import type { NoticePort } from "../notices/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import { createDrizzleBranchPushStore } from "./adapters/drizzle-branch-push.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import {
  createDrizzleLiveTurnDependencyStore,
  type LiveTurnDependencyStore,
} from "./adapters/drizzle-live-dependencies.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createDrizzleTurnReceiptStore } from "./adapters/drizzle-turn-receipt.js";
import { createHocuspocusCoordinator } from "./adapters/hocuspocus-coordinator.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
  type InMemoryJournal,
} from "./adapters/in-memory/agent-edit.js";
import { createCheckpointService } from "./checkpoints.js";
import {
  asLiveAgentEditCore,
  asThreadPeerAgentEditCore,
  type LiveAgentEditCore,
  type ThreadPeerAgentEditCore,
} from "./domain/agent-edit-cores.js";
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
  type PushToLiveResult,
} from "./domain/branch-push.js";
import { BranchCorruptError, BranchNotFoundError } from "./domain/branch-resolver.js";
import type { ReviewableDraft } from "./domain/branch-review.js";
import { touchDocumentActivity, updateMarkdownProjection } from "./domain/document-activity.js";
import { computeDraftReviewHunks } from "./domain/draft-review-hunks.js";
import {
  createMarkdownDocumentEngine,
  type RuntimeOrigin,
  syncErrorMessage,
} from "./domain/markdown-document.js";
import {
  enlistResponseParticipant,
  runResponseTransaction,
} from "./domain/response-transaction.js";
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
  notices?: NoticePort;
};

const BRANCH_AGENT_BROADCAST_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "branch-agent-append" } },
} satisfies TransactionOrigin;

function documentTitleFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const segment = uri.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  return segment.replace(/\.[^.]+$/, "");
}

export async function recordLateSweepNotice(input: {
  notices: NoticePort;
  resolveDocumentUri: DocumentUriResolver;
  threadId: string;
  documentId: string;
  lateSweep: import("@meridian/agent-edit").DestructiveSweepReport;
}): Promise<void> {
  const uri = await input.resolveDocumentUri(input.documentId);
  await input.notices.record({
    kind: "late_sweep",
    scope: { kind: "thread", threadId: input.threadId },
    message: "Content was modified — View change",
    data: {
      documentId: input.documentId,
      documentName: documentTitleFromUri(uri) ?? input.documentId,
      uri,
      affectedBlockHashes: input.lateSweep.affectedBlockHashes,
      capturedDeletedBodies: input.lateSweep.capturedDeletedBodies ?? [],
      beforeContentRef: input.lateSweep.beforeContentRef,
    },
    writerVisible: true,
  });
}

export async function recordAwarenessDegradedNotice(input: {
  notices: NoticePort;
  resolveDocumentUri: DocumentUriResolver;
  threadId: string;
  documentIds: readonly string[];
}): Promise<void> {
  const documentNames = await Promise.all(
    input.documentIds.map(async (documentId) => {
      const uri = await input.resolveDocumentUri(documentId);
      return documentTitleFromUri(uri) ?? documentId;
    }),
  );
  await input.notices.record({
    kind: "awareness_degraded",
    scope: { kind: "thread", threadId: input.threadId },
    message:
      "Your changes are committed, but concurrent writer content could not be verified. Re-read to confirm current state.",
    data: { documentIds: [...input.documentIds], documentNames },
    writerVisible: false,
  });
}

export async function recordNoticeAfterDurability(
  input: {
    notices: NoticePort;
    eventSink?: EventSink;
    setFence(documentIds: readonly string[]): void;
    threadId: string;
    documentIds: readonly string[];
    kind: string;
    responseId?: string;
    affectedBlockHashes?: readonly string[];
    recordDegraded?: () => Promise<void>;
  },
  record: () => Promise<void>,
): Promise<void> {
  try {
    await record();
  } catch (cause) {
    input.setFence(input.documentIds);
    if (input.eventSink) {
      emitEvent(input.eventSink, {
        level: "error",
        source: "collab.safety_notices",
        name: "record_failed_after_durability",
        payload: {
          kind: input.kind,
          threadId: input.threadId,
          documentIds: [...input.documentIds],
          ...(input.responseId ? { responseId: input.responseId } : {}),
          ...(input.affectedBlockHashes
            ? { affectedBlockHashes: [...input.affectedBlockHashes] }
            : {}),
          cause: unknownToEventPayload(cause),
        },
      });
    }
    try {
      await input.recordDegraded?.();
    } catch (degradedCause) {
      if (input.eventSink) {
        emitEvent(input.eventSink, {
          level: "error",
          source: "collab.safety_notices",
          name: "degraded_record_failed_after_durability",
          payload: {
            threadId: input.threadId,
            documentIds: [...input.documentIds],
            ...(input.responseId ? { responseId: input.responseId } : {}),
            cause: unknownToEventPayload(degradedCause),
          },
        });
      }
    }
  }
}

/** Leading-slash manuscript path for client navigation; null for other schemes. */
function manuscriptContextPath(uri: string | null): string | null {
  if (!uri?.startsWith("manuscript://")) return null;
  const path = uri.slice("manuscript://".length).replace(/^\/+/, "");
  return path ? `/${path}` : null;
}

type CheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  reason: string;
  createdAt: string;
};

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  responseId?: string | null;
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
  reversalNoticePort?: ReversalNoticePort;
  notices?: NoticePort;
  liveLineage: TurnLiveLineageReadModel;
  liveDependencyStore?: LiveTurnDependencyStore;
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
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
};

export function createReversalNoticePort(deps: {
  notices: NoticePort;
  documentUriResolver: DocumentUriResolver;
  eventSink?: EventSink;
}): ReversalNoticePort {
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
      await deps.notices.record({
        kind: "undo",
        scope: { kind: "thread", threadId: input.threadId },
        message: "",
        data: {
          threadId: input.threadId,
          writeHandles: input.writeHandles,
          writeHandleTurns,
          documentId: input.docId,
          uri,
          direction: input.direction,
          sweptContent: input.sweptContent,
          beforeContentRef: input.beforeContentRef,
        },
        writerVisible: false,
      });
    },
    async recordLateSweep(input) {
      await recordLateSweepNotice({
        notices: deps.notices,
        resolveDocumentUri: deps.documentUriResolver,
        threadId: input.threadId,
        documentId: input.docId,
        lateSweep: input.report,
      });
    },
  };
}

export function createCollabDomain(deps: CollabDomainDeps): CollabDomain {
  const { journal, lifecycle, store } = createDrizzleCollabPersistence(deps.db);
  const liveLineageStore = createDrizzleTurnLiveLineageStore(deps.db);
  const liveDependencyStore = createDrizzleLiveTurnDependencyStore(deps.db);
  const turnReceiptStore = createDrizzleTurnReceiptStore(deps.db);
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
            Y.applyUpdate(branchDoc, update, BRANCH_AGENT_BROADCAST_ORIGIN);
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
    liveJournal: journal,
  });
  const documentUriResolver = createDocumentUriResolver(deps.db);
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
    notices: deps.notices,
    resolveDocumentTitle: async (documentId) =>
      documentTitleFromUri(await documentUriResolver(documentId)),
  });

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
    documentUriResolver,
    liveLineage: createTurnLiveLineageReadModel({
      store: liveLineageStore,
      receiptStore: turnReceiptStore,
      resolveDocumentUri: documentUriResolver,
    }),
    liveDependencyStore,
    reversalNoticePort: deps.notices
      ? createReversalNoticePort({
          notices: deps.notices,
          documentUriResolver,
          eventSink: deps.eventSink,
        })
      : undefined,
    notices: deps.notices,
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
    commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(deps.db, operation),
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
  let boundHocuspocus: Hocuspocus | null = null;

  return createFacade({
    journal,
    coordinator,
    lifecycle,
    store: inMemoryStore(journal),
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
    commitThreadResponseAtomically: (operation) => operation(),
    hocuspocus: () => boundHocuspocus,
    bindHocuspocus(instance) {
      boundHocuspocus = instance;
    },
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
      ...agentEditObservabilityOptions(deps),
    });
  const liveUtilityCore = asLiveAgentEditCore(createLiveCore());
  const branchAgentEdit =
    deps.branchStore && deps.branchCoordinator
      ? { store: deps.branchStore, coordinator: deps.branchCoordinator }
      : null;
  const agentEditCore: ThreadPeerAgentEditCore = branchAgentEdit
    ? createThreadPeerAgentEditCore({
        liveUtilityCore,
        commitThreadResponseAtomically: deps.commitThreadResponseAtomically,
        createThreadCore: (threadId) => {
          const pendingJournalEntries = createBranchPendingJournalEntries(deps.eventSink);
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
              liveJournal: deps.journal,
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
            ...agentEditObservabilityOptions(deps),
          });
        },
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
        captureLiveInteraction: (documentId) =>
          deps.coordinator.withDocument(documentId, async (doc) => {
            const snapshot = await deps.journal.readForReconstruction(documentId);
            return {
              mode: "live" as const,
              baselineSnapshot: Y.encodeStateAsUpdate(doc),
              liveJournalSeq: snapshot.updates.reduce(
                (latest, update) => Math.max(latest, update.seq),
                0,
              ),
            };
          }),
      })
    : asThreadPeerAgentEditCore(liveUtilityCore);
  const markdownDocuments = createMarkdownDocumentEngine({
    codec: markupCodec,
    model,
    journal: deps.journal,
    coordinator: deps.coordinator,
    lifecycle: deps.lifecycle,
    metaForOrigin,
    afterWrite: runDocumentWriteHook,
    identityPreservingWrite: ({ documentId, markdown, actor }) =>
      liveUtilityCore.write(
        {
          command: "create",
          file: "document.md",
          documentId,
          content: markdown,
          overwrite: true,
        },
        {
          actor,
          sessionId:
            actor.kind === "human"
              ? `human:${actor.userId}`
              : actor.kind === "agent"
                ? `agent:${actor.turnId}`
                : `system:${actor.origin}`,
          ...(actor.kind === "agent" || actor.kind === "human" ? { threadId: actor.threadId } : {}),
        },
      ),
  });
  async function resolveDraftOnlyDocumentIds(input: {
    projectId?: ProjectId;
    workId: WorkId;
  }): Promise<Set<DocumentId>> {
    if (!input.projectId || !deps.manifestMembership) return new Set();
    // Resolve live first: both adapter calls ensure the project manifest,
    // and racing them on a project without one violates its unique identity.
    const liveMembership = await deps.manifestMembership.resolveManifestMembership({
      projectId: input.projectId,
    });
    const draftMembership = await deps.manifestMembership.resolveManifestMembership({
      projectId: input.projectId,
      workId: input.workId,
    });
    const liveDocumentIds = new Set(liveMembership.members);
    return new Set(
      draftMembership.members.filter((documentId) => !liveDocumentIds.has(documentId)),
    );
  }

  async function listReviewableWorkDraftBranches(
    workId: WorkId,
    projectId?: ProjectId,
  ): Promise<ReviewableDraft[]> {
    if (!deps.branchStore || !deps.branchPushStore) return [];
    const draftOnlyDocumentIds = await resolveDraftOnlyDocumentIds({ projectId, workId });
    const branchIds = await deps.branchPushStore.listActiveWorkDraftBranchIdsForWork(workId);
    const drafts: ReviewableDraft[] = [];
    for (const branchId of branchIds) {
      const branch = await deps.branchStore.getBranch(branchId);
      if (branch?.kind !== "work_draft" || branch.status !== "active" || branch.workId !== workId) {
        continue;
      }
      const rows = await (
        deps.branchPushStore.listReviewableJournalRows ?? deps.branchPushStore.listActiveJournalRows
      )(branch.branchId, branch.generation);
      if (rows.length === 0) continue;
      const uri = (await deps.documentUriResolver?.(branch.documentId)) ?? null;
      drafts.push({
        id: branch.branchId,
        documentId: branch.documentId,
        workId,
        status: "active",
        branchId: branch.branchId,
        generation: branch.generation,
        lastActorTurnId: rows.find((row) => row.turnId)?.turnId ?? null,
        appliedAt: null,
        discardedAt: null,
        undoneAt: null,
        wordsAdded: null,
        wordsRemoved: null,
        updatedAt: new Date(),
        documentName: documentTitleFromUri(uri),
        // Manuscript-only: the client review launcher hard-codes scheme
        // "manuscript" for navigation, so a kb/scratch path here would send
        // the writer to a nonexistent manuscript route. Leading slash matches
        // the client's route/tree path convention (formatContextPath) —
        // canonical URIs carry none, but findContextFile matches exactly.
        contextPath: manuscriptContextPath(uri),
        ...(draftOnlyDocumentIds.has(branch.documentId) ? { createdDocument: true } : {}),
      });
    }
    return drafts;
  }

  async function previewWorkDraftBranch(input: {
    projectId?: ProjectId;
    documentId: DocumentId;
    workId: WorkId;
  }) {
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
          await (
            deps.branchPushStore.listReviewableJournalRows ??
            deps.branchPushStore.listActiveJournalRows
          )(branch.branchId, branch.generation)
        ).map((row) => ({
          id: row.id,
          actorTurnId: row.turnId,
          actorUserId: row.actorUserId,
          updateData: row.updateData,
          updateKind: row.status === "rollback_pending" ? "rollback_pending" : row.source,
        }));
        const review = computeDraftReviewHunks({
          liveDoc,
          draftDoc: branch.doc,
          model,
          draftUpdates,
          partitionClosureClasses: true,
        });
        return {
          status: "active" as const,
          branchId: branch.branchId,
          live: liveState.markdown,
          markdown: markdownDocuments.serializeDoc(branch.doc),
          isNewDocument: await isDraftOnlyManifestDocument({
            projectId: input.projectId,
            workId: input.workId,
            documentId: input.documentId,
          }),
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

  async function isDraftOnlyManifestDocument(input: {
    projectId?: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
  }): Promise<boolean> {
    return (await resolveDraftOnlyDocumentIds(input)).has(input.documentId);
  }

  async function pushNewDocumentToLiveWithManifest(input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    branchId: string;
    journalIds?: readonly number[];
    userId: UserId;
    signal?: AbortSignal;
  }): Promise<PushToLiveResult> {
    if (!deps.branchPush || !deps.branchStore) throw new Error("draft_not_found");
    const manifest = await deps.branchStore.ensureProjectManifest({ projectId: input.projectId });
    try {
      const manifestBranch = await deps.branchStore.resolveWorkDraftBranchForWork({
        documentId: manifest.documentId,
        workId: input.workId,
        liveDoc: manifest.doc,
      });
      try {
        return await deps.branchPush.pushToLiveWithManifestEntry({
          branchId: input.branchId,
          manifestBranchId: manifestBranch.branchId,
          manifestEntryDocumentId: input.documentId,
          ...(input.journalIds ? { contentJournalIds: input.journalIds } : {}),
          pushedByUserId: input.userId,
          signal: input.signal,
        });
      } finally {
        manifestBranch.doc.destroy();
      }
    } finally {
      manifest.doc.destroy();
    }
  }

  async function removeNewDocumentFromWorkManifest(input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
  }): Promise<void> {
    if (!deps.manifestMembership) return;
    const mutation = await deps.manifestMembership.recordManifestDocumentDeleted(
      input.documentId,
      input,
    );
    if (mutation?.workDraftBranchId && deps.branchPush) {
      await deps.branchPush.pushAutoBranchAfterThreadPeerWrite({
        workDraftBranchId: mutation.workDraftBranchId,
      });
    }
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
    notices: deps.notices,
    model,
    codec,
  });
  const hocuspocusPersistence = createHocuspocusPersistenceService({
    journal: deps.journal,
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

  async function readEffective<T, E>(
    input: EffectiveReadInput,
    read: (doc: Y.Doc) => T,
    fallback: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E>> {
    if (input.threadId && deps.branchStore) {
      const isStagedOnlyCreatedDocument = Boolean(
        input.responseId &&
          agentEditCore
            .stagedCreatedDocumentIds(input.responseId, input.threadId)
            .includes(input.documentId),
      );
      if (isStagedOnlyCreatedDocument) {
        const stagedOnly = readStagedResponseOnly(input, read);
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
        const branch = await deps.branchStore.resolveThreadBranch(input.documentId, input.threadId);
        return Ok(await readEffectiveBranch(branch, input, read));
      } catch (cause) {
        if (!(cause instanceof BranchNotFoundError)) throw cause;
      }
      try {
        const workDraft = await deps.branchStore.resolveWorkDraftBranchForThread(
          input.documentId,
          input.threadId,
        );
        return Ok(await readEffectiveBranch(workDraft, input, read));
      } catch (cause) {
        if (!(cause instanceof BranchNotFoundError)) throw cause;
      }
      const stagedOnly = readStagedResponseOnly(input, read);
      if (stagedOnly !== null) return Ok(stagedOnly);
    }
    return fallback();
  }

  async function readEffectiveBranch<T>(
    branch: { branchId: string; doc: Y.Doc },
    input: EffectiveReadInput,
    read: (doc: Y.Doc) => T,
  ): Promise<T> {
    try {
      if (deps.branchCoordinator) {
        return deps.branchCoordinator.readBranch(branch.branchId, async (doc) =>
          readWithStagedResponseOverlay(doc, input, read),
        );
      }
      return readWithStagedResponseOverlay(branch.doc, input, read);
    } finally {
      branch.doc.destroy();
    }
  }

  return {
    agentEdit() {
      return agentEditCore;
    },

    draftReview: {
      async list(input) {
        return input.workId ? listReviewableWorkDraftBranches(input.workId, input.projectId) : [];
      },
      async preview(input) {
        if (input.workId) {
          const branchPreview = await previewWorkDraftBranch({
            projectId: input.projectId,
            documentId: input.documentId,
            workId: input.workId,
          });
          if (branchPreview) return branchPreview;
        }
        const live = await markdownDocuments.readAsMarkdown(input.documentId);
        if (!live.ok) throw new Error(`read_failed:${live.error.code}`);
        return { status: "gone", live: live.value };
      },
      async journal() {
        return { status: "not_found" as const };
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
            const selectedOperationIds = input.operationIds ?? [];
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
            if (selectedOperationIds.length > 0) {
              const preview = await previewWorkDraftBranch({
                projectId: input.projectId,
                documentId: input.documentId,
                workId: input.workId,
              });
              if (preview?.status !== "active") throw new Error("draft_not_found");
              const requested = new Set(selectedOperationIds);
              const operationIds = new Set<string>();
              for (const operation of preview.operations) {
                if (!requested.has(operation.operationId)) continue;
                for (const id of operation.acceptClosureOperationIds ?? [operation.operationId]) {
                  operationIds.add(id);
                }
              }
              const updateIds = new Set<number>();
              for (const operation of preview.operations) {
                if (!operationIds.has(operation.operationId)) continue;
                for (const id of operation.directionalClosure.accept.updateIds) updateIds.add(id);
              }
              if (preview.isNewDocument && input.projectId) {
                const pushed = await pushNewDocumentToLiveWithManifest({
                  projectId: input.projectId,
                  workId: input.workId,
                  documentId: input.documentId,
                  branchId: branch.branchId,
                  journalIds: [...updateIds],
                  userId: input.userId,
                  signal: input.signal,
                });
                if (pushed.status === "push_concurrent_conflict") {
                  return {
                    status: "concurrent_conflict" as const,
                    conflictedBlocks: pushed.conflictedBlocks,
                  };
                }
              } else {
                const pushed = await deps.branchPush.pushSelectedToLive({
                  branchId: branch.branchId,
                  journalIds: [...updateIds],
                  pushedByUserId: input.userId,
                  signal: input.signal,
                });
                if (pushed.status === "push_concurrent_conflict") {
                  return {
                    status: "concurrent_conflict" as const,
                    conflictedBlocks: pushed.conflictedBlocks,
                  };
                }
              }
              return {
                status: "partial_applied" as const,
                draftId: branch.branchId,
                appliedUpdateSeq: 0,
                acceptedOperationIds: [...operationIds].sort(),
                writeId: [...updateIds].sort((a, b) => a - b).join(","),
              };
            }
            if (input.projectId) {
              const pushed = await pushNewDocumentToLiveWithManifest({
                projectId: input.projectId,
                workId: input.workId,
                documentId: input.documentId,
                branchId: branch.branchId,
                userId: input.userId,
                signal: input.signal,
              });
              if (pushed.status === "push_concurrent_conflict") {
                return {
                  status: "concurrent_conflict" as const,
                  conflictedBlocks: pushed.conflictedBlocks,
                };
              }
            } else {
              const pushed = await deps.branchPush.pushToLive({
                branchId: branch.branchId,
                pushedByUserId: input.userId,
                signal: input.signal,
              });
              if (pushed.status === "push_concurrent_conflict") {
                return {
                  status: "concurrent_conflict" as const,
                  conflictedBlocks: pushed.conflictedBlocks,
                };
              }
            }
            return {
              status: "applied" as const,
              draftId: branch.branchId,
              branchId: branch.branchId,
              appliedUpdateSeq: 0,
            };
          }
        }
        return { status: "not_found" as const, draftId: input.draftId ?? input.branchId ?? "" };
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
            if (input.operationIds && input.operationIds.length > 0) {
              if (!deps.branchPush || !deps.branchPushStore) throw new Error("draft_not_found");
              const preview = await previewWorkDraftBranch({
                projectId: input.projectId,
                documentId: input.documentId,
                workId: input.workId,
              });
              if (preview?.status !== "active") throw new Error("draft_not_found");
              const requested = new Set(input.operationIds);
              const operationIds = new Set<string>();
              for (const operation of preview.operations) {
                if (!requested.has(operation.operationId)) continue;
                for (const id of operation.rejectClosureOperationIds ?? [operation.operationId]) {
                  operationIds.add(id);
                }
              }
              const updateIds = new Set<number>();
              for (const operation of preview.operations) {
                if (!operationIds.has(operation.operationId)) continue;
                for (const id of operation.directionalClosure.reject.updateIds) updateIds.add(id);
              }
              await deps.branchPush.discardSelected({
                branchId: branch.branchId,
                journalIds: [...updateIds],
                reviewedByUserId: input.userId,
              });
            } else {
              if (
                input.projectId &&
                (await isDraftOnlyManifestDocument({
                  projectId: input.projectId,
                  workId: input.workId,
                  documentId: input.documentId,
                }))
              ) {
                await removeNewDocumentFromWorkManifest({
                  projectId: input.projectId,
                  workId: input.workId,
                  documentId: input.documentId,
                });
              }
              await deps.coordinator.withDocument(input.documentId, async (liveDoc) =>
                deps.branchCoordinator?.resetFromDoc(branch.branchId, liveDoc),
              );
              await agentEditCore.invalidateThread(input.documentId, input.threadId ?? "");
            }
            return {
              status: "discarded" as const,
              draftId: branch.branchId,
              branchId: branch.branchId,
            };
          }
        }
        return { status: "discarded" as const, draftId: input.draftId ?? input.branchId ?? "" };
      },
      async undoAccept(input) {
        return { status: "not_found" as const, draftId: input.draftId };
      },
      async undoReject(input) {
        return { status: "not_found" as const, draftId: input.draftId };
      },
    },

    draftSessionStats: {
      countInFlightDraftSessionsByWork() {
        return 0;
      },
      async listActiveDraftsByWork(input) {
        return (await listReviewableWorkDraftBranches(input.workId)).filter(
          (draft): draft is ReviewableDraft & { status: "active" } => draft.status === "active",
        );
      },
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

    getTurnReceiptChip(threadId, turnId) {
      return deps.liveLineage.getTurnReceiptChip(threadId, turnId);
    },

    getTurnChangeDiff(threadId, turnId) {
      if (!deps.branchPush) throw new Error("Branch push service is not configured");
      return deps.branchPush.getTurnChangeDiff({ threadId, turnId });
    },

    async finalizeResponseCommit(responseId, ctx) {
      const stagedCreateIds = agentEditCore.stagedCreatedDocumentIds(responseId, ctx.threadId);
      const result = await agentEditCore.commitResponse(responseId);
      if (result.status === "rejected") {
        const rejections = await Promise.all(
          result.rejections.map(async (rejection) => {
            const uri = await (deps.documentUriResolver ?? (async () => null))(
              rejection.documentId,
            );
            return {
              ...rejection,
              documentName: documentTitleFromUri(uri) ?? rejection.documentId,
            };
          }),
        );
        return {
          ...result,
          rejections,
          stagedCreates: { committed: [], discarded: [...stagedCreateIds] },
        };
      }
      if (result.awarenessDegraded) {
        const documentIds = result.documents.map((document) => document.documentId);
        agentEditCore.setReadRequiredFence(ctx.threadId, documentIds);
        if (deps.notices)
          await recordNoticeAfterDurability(
            {
              notices: deps.notices,
              eventSink: deps.eventSink,
              setFence: (ids) => agentEditCore.setReadRequiredFence(ctx.threadId, ids),
              threadId: ctx.threadId,
              documentIds,
              kind: "awareness_degraded",
              responseId,
            },
            () =>
              recordAwarenessDegradedNotice({
                notices: deps.notices as NoticePort,
                resolveDocumentUri: deps.documentUriResolver ?? (async () => null),
                threadId: ctx.threadId,
                documentIds,
              }),
          );
      }
      for (const document of result.documents) {
        const { lateSweep } = document;
        if (lateSweep) {
          agentEditCore.setReadRequiredFence(ctx.threadId, [document.documentId]);
          if (deps.notices)
            await recordNoticeAfterDurability(
              {
                notices: deps.notices,
                eventSink: deps.eventSink,
                setFence: (ids) => agentEditCore.setReadRequiredFence(ctx.threadId, ids),
                threadId: ctx.threadId,
                documentIds: [document.documentId],
                kind: "late_sweep",
                responseId,
                affectedBlockHashes: lateSweep.affectedBlockHashes,
                recordDegraded: () =>
                  recordAwarenessDegradedNotice({
                    notices: deps.notices as NoticePort,
                    resolveDocumentUri: deps.documentUriResolver ?? (async () => null),
                    threadId: ctx.threadId,
                    documentIds: [document.documentId],
                  }),
              },
              () =>
                recordLateSweepNotice({
                  notices: deps.notices as NoticePort,
                  resolveDocumentUri: deps.documentUriResolver ?? (async () => null),
                  threadId: ctx.threadId,
                  documentId: document.documentId,
                  lateSweep,
                }),
            );
        }
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
      return {
        status: "committed",
        documents: result.documents,
        stagedCreates: result.stagedCreates,
        ...(result.awarenessDegraded ? { awarenessDegraded: true } : {}),
      };
    },

    setReadRequiredFence(threadId, documentIds) {
      agentEditCore.setReadRequiredFence(threadId, documentIds);
    },

    async finalizeResponseRollback(responseId, ctx) {
      const activeBranchRows = deps.branchPushStore?.listJournalRowsForTurn
        ? await deps.branchPushStore.listJournalRowsForTurn({
            threadId: ctx.threadId,
            turnId: ctx.turnId,
            statuses: ["active"],
          })
        : [];
      const result = await agentEditCore.rollbackResponse(responseId);

      if (deps.branchPush && deps.branchStore) {
        for (const branchId of [...new Set(activeBranchRows.map((row) => row.branchId))]) {
          const branch = await deps.branchStore.getBranch(branchId);
          if (
            branch?.kind !== "work_draft" ||
            branch.status !== "active" ||
            !activeBranchRows.some(
              (row) => row.branchId === branchId && row.generation === branch.generation,
            )
          ) {
            continue;
          }
          await deps.branchPush.markFailedResponseRollbackPending({
            branchId,
            threadId: ctx.threadId,
            turnId: ctx.turnId,
          });
        }
      }

      await reverseTurnAcrossDocuments(
        {
          reversalStore: deps.journal,
          agentEdit: liveUtilityCore,
          resolveDocumentUri: deps.documentUriResolver ?? (async (documentId) => documentId),
          checkDependentLaterLiveRows: deps.liveDependencyStore?.checkDependentLaterLiveRows,
          refreshDocumentProjection: (projection) =>
            refreshDocumentProjection(projection.documentId, projection.threadId),
          captureInteractionContext: (documentId) =>
            deps.coordinator.withDocument(documentId, async (doc) => {
              const snapshot = await deps.journal.readForReconstruction(documentId);
              return {
                mode: "live" as const,
                baselineSnapshot: Y.encodeStateAsUpdate(doc),
                liveJournalSeq: snapshot.updates.reduce(
                  (latest, update) => Math.max(latest, update.seq),
                  0,
                ),
              };
            }),
        },
        {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          direction: "undo",
          actor: { type: "agent" },
        },
      );

      return { stagedCreates: result.stagedCreates };
    },

    async writeFromMarkdown(documentId, markdown, origin) {
      return markdownDocuments.writeFromMarkdown(documentId, markdown, origin);
    },

    async reverseTurn(input) {
      const liveOutcome = await reverseTurnAcrossDocuments(
        {
          reversalStore: deps.journal,
          agentEdit: liveUtilityCore,
          resolveDocumentUri: deps.documentUriResolver ?? (async (documentId) => documentId),
          checkDependentLaterLiveRows: deps.liveDependencyStore?.checkDependentLaterLiveRows,
          refreshDocumentProjection: (projection) =>
            refreshDocumentProjection(projection.documentId, projection.threadId),
        },
        input,
      );
      if (!deps.branchPush || !deps.branchPushStore?.listJournalRowsForTurn) return liveOutcome;
      const statuses = input.direction === "undo" ? ["active" as const] : ["discarded" as const];
      const rows = await deps.branchPushStore.listJournalRowsForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        statuses,
      });
      const branchIds = [...new Set(rows.map((row) => row.branchId))];
      if (branchIds.length === 0) return liveOutcome;
      const documents = [...liveOutcome.documents];
      for (const branchId of branchIds) {
        const branch = await deps.branchStore?.getBranch(branchId);
        if (!branch) continue;
        const result = await deps.branchPush.reverseBranchTurn({
          branchId,
          threadId: input.threadId,
          turnId: input.turnId,
          direction: input.direction,
          reviewedByUserId:
            input.actor.type === "user" ? (input.actor.userId as UserId) : undefined,
        });
        documents.push({
          uri: (await deps.documentUriResolver?.(branch.documentId)) ?? branch.documentId,
          status: result.status,
        });
      }
      return { status: aggregateTurnReverseStatus(input.direction, documents), documents };
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
    pushSelectedToLive(input) {
      if (!deps.branchPush) throw new Error("Branch push service is not configured");
      return deps.branchPush.pushSelectedToLive(input);
    },
    countUnpushedRowsForWork(workId) {
      if (!deps.branchPushStore) return Promise.resolve(0);
      return deps.branchPushStore.countUnpushedRowsForWork(workId);
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
      return readEffective(input, markdownDocuments.serializeDoc, () =>
        markdownDocuments.readAsMarkdown(input.documentId),
      );
    },

    async readEffectiveHashlines(input) {
      return readEffective(
        input,
        (doc) => model.serializeBlockLines(toDocHandle(doc), codec),
        () =>
          deps.coordinator.withDocument(input.documentId, async (doc) =>
            Ok(model.serializeBlockLines(toDocHandle(doc), codec)),
          ),
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

    resolveBranchHocuspocusRoom: hocuspocusPersistence.resolveBranchHocuspocusRoom,

    loadHocuspocusDocument: hocuspocusPersistence.loadHocuspocusDocument,

    loadHocuspocusBranchState: hocuspocusPersistence.loadHocuspocusBranchState,

    persistConnectionUpdate: hocuspocusPersistence.persistConnectionUpdate,

    persistBranchConnectionUpdate: hocuspocusPersistence.persistBranchConnectionUpdate,

    storeHocuspocusDocument: hocuspocusPersistence.storeHocuspocusDocument,

    storeHocuspocusBranch: hocuspocusPersistence.storeHocuspocusBranch,

    drainHocuspocusPersistence: hocuspocusPersistence.drainHocuspocusPersistence,

    drainHocuspocusBranchPersistence: hocuspocusPersistence.drainHocuspocusBranchPersistence,

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
  liveUtilityCore: LiveAgentEditCore;
  createThreadCore(threadId: ThreadId): AgentEditCore;
  discardThreadPeerBranches?(documentId: DocumentId, threadId: string): Promise<void>;
  beforeThreadInteraction?(input: { documentId: DocumentId; threadId: ThreadId }): Promise<
    | {
        changed?: boolean;
        baselineSnapshot?: Uint8Array;
        branchGeneration: number;
        afterJournalId?: number;
        liveJournalSeq?: number;
      }
    | undefined
  >;
  captureLiveInteraction?(documentId: string): Promise<{
    mode: "live";
    baselineSnapshot: Uint8Array;
    liveJournalSeq: number;
  }>;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  maxThreadCores?: number;
}): ThreadPeerAgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  const activeResponseIds = new Map<ThreadId, Set<string>>();
  const responseOwners = new Map<string, { threadId?: ThreadId; core: AgentEditCore }>();
  const pendingInteractionBaselines = new Map<
    string,
    {
      snapshot: Uint8Array;
      afterJournalId: number;
      liveJournalSeq?: number;
      interactionId: string;
      branchGeneration: number;
    }
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
      const evicted = cores.get(oldest);
      await evicted?.invalidateThread("", oldest);
      cores.delete(oldest);
      activeResponseIds.delete(oldest);
      clearPendingBaselinesForThread(oldest);
    }
  }

  function trackResponse(
    threadId: string | undefined,
    responseId: string | undefined,
    core: AgentEditCore,
  ): void {
    if (!responseId) return;
    const id = threadId as ThreadId | undefined;
    const owner = responseOwners.get(responseId);
    if (owner && owner.core !== core) {
      throw new Error(
        `Response ${responseId} is already owned by thread ${owner.threadId ?? "live"}; cannot reuse it from thread ${id ?? "live"}.`,
      );
    }
    responseOwners.set(responseId, { ...(id ? { threadId: id } : {}), core });
    if (!id) return;
    const active = activeResponseIds.get(id) ?? new Set<string>();
    active.add(responseId);
    activeResponseIds.set(id, active);
  }

  function interactionIdFromContext(context: {
    responseId?: string;
    tool_use_id?: string;
    turnId?: string;
  }): string | null {
    return context.tool_use_id ?? context.responseId ?? context.turnId ?? null;
  }

  function clearPendingBaselinesForInteraction(interactionId: string): void {
    for (const [key, pending] of pendingInteractionBaselines) {
      if (pending.interactionId === interactionId) pendingInteractionBaselines.delete(key);
    }
  }

  async function untrackResponse(responseId: string): Promise<void> {
    clearPendingBaselinesForInteraction(responseId);
    const owner = responseOwners.get(responseId);
    responseOwners.delete(responseId);
    if (owner?.threadId) {
      const active = activeResponseIds.get(owner.threadId);
      active?.delete(responseId);
      if (active?.size === 0) activeResponseIds.delete(owner.threadId);
    } else {
      // Defensive cleanup for response ownership created before this process-local map.
      for (const [threadId, active] of activeResponseIds) {
        active.delete(responseId);
        if (active.size === 0) activeResponseIds.delete(threadId);
      }
    }
    await evictIdleCores();
  }

  return asThreadPeerAgentEditCore({
    async write(command, context = {}) {
      const documentId = documentIdFromWriteCommand(command);
      const threadCore = await coreFor(context.threadId);
      trackResponse(context.threadId, context.responseId, threadCore);
      let interactionContext:
        | {
            mode: "threadPeer";
            baselineSnapshot?: Uint8Array;
            afterJournalId: number;
            liveJournalSeq?: number;
            branchGeneration: number;
          }
        | undefined;
      const responseAlreadyBufferedDocument = Boolean(
        context.responseId &&
          documentId &&
          threadCore.bufferedUpdatesForDoc(context.responseId, documentId).length > 0,
      );
      if (
        documentId &&
        context.threadId &&
        input.beforeThreadInteraction &&
        !responseAlreadyBufferedDocument
      ) {
        const baselineKey = pendingBaselineKey(context.threadId, documentId);
        const interactionId = interactionIdFromContext(context);
        const pulled = await input.beforeThreadInteraction({
          documentId,
          threadId: context.threadId as ThreadId,
        });
        const pendingBaseline = pendingInteractionBaselines.get(baselineKey);
        const currentGeneration = pulled?.branchGeneration;
        const generationMatches =
          pendingBaseline &&
          pendingBaseline.interactionId === interactionId &&
          pendingBaseline.branchGeneration === currentGeneration;
        if (pendingBaseline && !generationMatches) pendingInteractionBaselines.delete(baselineKey);
        const usablePending = generationMatches ? pendingBaseline : undefined;
        if (pulled?.changed && pulled.baselineSnapshot) {
          interactionContext = {
            mode: "threadPeer",
            baselineSnapshot: usablePending?.snapshot ?? pulled.baselineSnapshot,
            afterJournalId: usablePending?.afterJournalId ?? pulled.afterJournalId ?? 0,
            liveJournalSeq: usablePending?.liveJournalSeq ?? pulled.liveJournalSeq,
            branchGeneration: usablePending?.branchGeneration ?? pulled.branchGeneration,
          };
          if (!usablePending && interactionId) {
            // This cache is scoped to one tool interaction (response id, or turn id
            // for non-streamed tests). It preserves the original pre-pull baseline
            // across a failed retry, but the interaction id and branch generation
            // fence it off from later writes so attribution remains cold.
            pendingInteractionBaselines.set(baselineKey, {
              snapshot: pulled.baselineSnapshot,
              interactionId,
              branchGeneration: pulled.branchGeneration,
              afterJournalId: pulled.afterJournalId ?? 0,
              liveJournalSeq: pulled.liveJournalSeq,
            });
          }
        } else {
          interactionContext = usablePending
            ? {
                mode: "threadPeer",
                baselineSnapshot: usablePending.snapshot,
                afterJournalId: usablePending.afterJournalId,
                liveJournalSeq: usablePending.liveJournalSeq,
                branchGeneration: usablePending.branchGeneration,
              }
            : pulled
              ? {
                  mode: "threadPeer",
                  afterJournalId: pulled.afterJournalId ?? 0,
                  liveJournalSeq: pulled.liveJournalSeq,
                  branchGeneration: pulled.branchGeneration,
                }
              : undefined;
        }
        if (!context.responseId && interactionContext) {
          await threadCore.invalidateThread(documentId, context.threadId);
        }
      }
      try {
        const result = await threadCore.write(command, {
          ...context,
          ...(interactionContext ? { interactionContext } : {}),
        });
        if (documentId && context.threadId && interactionContext) {
          const key = pendingBaselineKey(context.threadId, documentId);
          if (isSuccessfulAgentWrite(result)) {
            runAfterDrizzleCommit(() => {
              pendingInteractionBaselines.delete(key);
            });
          } else {
            pendingInteractionBaselines.delete(key);
          }
        }
        return result;
      } catch (cause) {
        if (documentId && context.threadId && interactionContext) {
          pendingInteractionBaselines.delete(pendingBaselineKey(context.threadId, documentId));
        }
        throw cause;
      }
    },
    recover(docId) {
      return Promise.all([...cores.values()].map((core) => core.recover(docId))).then(() => {});
    },
    async commitResponse(responseId) {
      const owner = responseOwners.get(responseId);
      if (!owner) return input.liveUtilityCore.commitResponse(responseId);
      return runResponseTransaction(input.commitThreadResponseAtomically, async () => {
        const result = await owner.core.commitResponse(responseId, {
          deferFinalization: (participant) => {
            if (!enlistResponseParticipant(participant)) {
              throw new Error("Response finalization requires an active response transaction");
            }
          },
        });
        enlistResponseParticipant({ commit: () => untrackResponse(responseId), abort() {} });
        return result;
      });
    },
    bufferedUpdatesForDoc(responseId, docId) {
      return responseOwners.get(responseId)?.core.bufferedUpdatesForDoc(responseId, docId) ?? [];
    },
    stagedCreatedDocumentIds(responseId, threadId) {
      const owner = responseOwners.get(responseId);
      if (owner) return owner.core.stagedCreatedDocumentIds(responseId, threadId);
      return threadId ? coreForSync(threadId).stagedCreatedDocumentIds(responseId, threadId) : [];
    },
    async rollbackResponse(responseId) {
      const owner = responseOwners.get(responseId);
      if (!owner) return input.liveUtilityCore.rollbackResponse(responseId);
      return runResponseTransaction(input.commitThreadResponseAtomically, async () => {
        const result = await owner.core.rollbackResponse(responseId, {
          deferFinalization: (participant) => {
            if (!enlistResponseParticipant(participant)) {
              throw new Error("Response finalization requires an active response transaction");
            }
          },
        });
        enlistResponseParticipant({ commit: () => untrackResponse(responseId), abort() {} });
        return result;
      });
    },
    setReadRequiredFence(sessionId, docIds) {
      coreForSync(sessionId).setReadRequiredFence(sessionId, docIds);
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
      await input.beforeThreadInteraction?.({
        documentId: inputReverse.docId as DocumentId,
        threadId: inputReverse.threadId as ThreadId,
      });
      const interactionContext =
        inputReverse.interactionContext ??
        (await input.captureLiveInteraction?.(inputReverse.docId));
      return input.liveUtilityCore.reverse({
        ...inputReverse,
        ...(interactionContext ? { interactionContext } : {}),
      });
    },
    async undoTurn(docId, threadId) {
      return (await coreFor(threadId)).undoTurn(docId, threadId);
    },
    async redoTurn(docId, threadId) {
      return (await coreFor(threadId)).redoTurn(docId, threadId);
    },
    async invalidateThread(docId, threadId) {
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
        const residentCore = cores.get(id);
        try {
          if (residentCore) await residentCore.invalidateThread(docId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
        cores.delete(id);
        activeResponseIds.delete(id);
        clearPendingBaselinesForThread(id, docId || undefined);
      } else {
        for (const [id, core] of [...cores]) {
          try {
            await core.invalidateThread(docId, id);
          } catch (cause) {
            errors.push(cause);
          }
          cores.delete(id);
          activeResponseIds.delete(id);
          clearPendingBaselinesForThread(id, docId || undefined);
        }
        try {
          await input.liveUtilityCore.invalidateThread(docId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Failed to invalidate all agent-edit runtimes");
    },
  });
}

function documentIdFromWriteCommand(command: unknown): DocumentId | null {
  if (typeof command !== "object" || command === null) return null;
  const { file, documentId } = command as { file?: unknown; documentId?: unknown };
  if (typeof file !== "string") return null;
  const address = parseDocumentAddress(
    file,
    typeof documentId === "string" ? documentId : undefined,
  );
  return address.ok ? (address.documentId as DocumentId) : null;
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

function aggregateTurnReverseStatus(
  direction: "undo" | "redo",
  documents: readonly { status: string }[],
): ReversalOutcome["status"] {
  const noOp = direction === "undo" ? "nothing_to_undo" : "nothing_to_redo";
  const success = direction === "undo" ? "reversed" : "reconciled";
  const statuses = documents.map((document) => document.status);
  if (statuses.length === 0 || statuses.every((status) => status === noOp)) return noOp;
  if (statuses.every((status) => status === success || status === noOp)) return success;
  if (statuses.includes("cant_undo_dependent")) return "cant_undo_dependent";
  return "partial";
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
  to: "preOwnSnapshot";
  reason: string;
}) => void {
  return (event) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "warn",
      source: "collab.agent_edit",
      name: "response_baseline.degraded",
      payload: { ...event },
    });
  };
}

function agentEditResponseLifecycleObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onResponseLifecycleError"]> {
  return (event) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.agent_edit",
      name: "response_lifecycle.error",
      correlation: {
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        errorCode: event.code,
      },
      payload: { ...event },
    });
  };
}

function agentEditResponseClaimDiscardedObservability(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onResponseClaimDiscarded"]> {
  return (event: ResponseLifecycleClaimDiscardedDetail) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "error",
      source: "collab.agent_edit",
      name: "response_lifecycle.claim_discarded",
      payload: { ...event },
    });
  };
}

function agentEditResponseCommitterTransitionObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onResponseCommitterTransition"]> {
  return (event) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "info",
      source: "collab.agent_edit",
      name: `response_committer.${event.transition}`,
      correlation: {
        ...(event.threadId ? { threadId: event.threadId } : {}),
      },
      payload: { ...event },
    });
  };
}

function agentEditObservabilityOptions(
  deps: Pick<CollabFacadeDeps, "eventSink" | "reversalNoticePort">,
): Pick<
  Parameters<typeof createAgentEditCore>[0],
  | "reversalNoticePort"
  | "onInvariantViolation"
  | "onBaselineDegraded"
  | "onResponseLifecycleError"
  | "onResponseClaimDiscarded"
  | "onResponseCommitterTransition"
  | "onIdempotencyHit"
  | "onReversalNoticeFailed"
> {
  return {
    ...(deps.reversalNoticePort ? { reversalNoticePort: deps.reversalNoticePort } : {}),
    onInvariantViolation: agentEditInvariantPolicy(deps.eventSink),
    onBaselineDegraded: agentEditBaselineDegradationObserver(deps.eventSink),
    onResponseLifecycleError: agentEditResponseLifecycleObserver(deps.eventSink),
    onResponseClaimDiscarded: agentEditResponseClaimDiscardedObservability(deps.eventSink),
    onResponseCommitterTransition: agentEditResponseCommitterTransitionObserver(deps.eventSink),
    onIdempotencyHit: agentEditIdempotencyHitObserver(deps.eventSink),
    onReversalNoticeFailed: reversalNoticeRecordFailedObserver(deps.eventSink),
  };
}

function agentEditIdempotencyHitObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onIdempotencyHit"]> {
  return (event: WriteIdempotencyHitDetail) => {
    if (!eventSink) return;
    emitEvent(eventSink, {
      level: "info",
      source: "collab.agent_edit",
      name: "write.idempotency_hit",
      payload: { ...event },
    });
  };
}

function reversalNoticeRecordFailedObserver(
  eventSink?: EventSink,
): NonNullable<Parameters<typeof createAgentEditCore>[0]["onReversalNoticeFailed"]> {
  return (event: ReversalNoticeFailedDetail) => {
    if (eventSink) {
      try {
        emitEvent(eventSink, {
          level: "error",
          source: "collab.undo_notifications",
          name: "record.failed",
          payload: { ...event },
        });
        return;
      } catch (cause) {
        console.error("agent-edit undo notification recording failed", event, cause);
        return;
      }
    }
    console.error("agent-edit undo notification recording failed", event);
  };
}
