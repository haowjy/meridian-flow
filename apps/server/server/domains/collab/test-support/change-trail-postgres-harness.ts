import { createDrizzleDraftAttributionStore } from "../adapters/drizzle-document-edits.js";
import { createDrizzleDraftCommands } from "../adapters/drizzle-draft-commands.js";
import { createDrizzleTurnInverseService } from "../adapters/drizzle-turn-inverse.js";
import { createDraftReviewIdentity } from "../domain/draft-review-identity.js";
import { createModelDocumentEdits } from "../domain/model-document-edits.js";
/** Focused real-Postgres harness for change-trail durability tests. */

import {
  createAgentEditCodecFactory,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DraftDecidedOutcome } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { createAllowAllFileAccess } from "../../../domains/file-policy/index.js";
import { testFileGrant } from "../../../test-support/file-grants.js";
import { createDocumentLastAddress } from "../../context/document-uri-resolver.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { hiddenDocumentIds } from "../../context/tree/end-use.js";
import type { FileGrant } from "../../file-policy/index.js";
import { createDrizzleCollabLookups } from "../adapters/drizzle-collab-lookups.js";
import { createDrizzleDocumentDerivationStore } from "../adapters/drizzle-document-derivations.js";
import { createDrizzleDraftDiscard } from "../adapters/drizzle-draft-discard.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../adapters/drizzle-drafts.js";
import {
  createStaticDocumentLinkScopes,
  UNSUPPORTED_AHEAD_REFS,
} from "../adapters/in-memory/static-document-link-scopes.js";
import { createDraftAttribution } from "../domain/draft-attribution.js";
import { createDraftBranchLeases } from "../domain/draft-branch-leases.js";
import { createDraftDiscard } from "../domain/draft-discard.js";
import { createDrafts } from "../domain/drafts.js";
import { createPeerRetirement } from "../domain/peer-retirement.js";
import type { DocumentLinkScopes } from "../domain/ports/document-link-scope.js";
import type { SettlementPublicationStep } from "../domain/ports/settlement-publication.js";
import { writeMarkdown } from "./bound-writes.js";
import { commitSegmentRows } from "./branch-update-writes.js";
import { draftRebaseDeps } from "./draft-rebase-deps.js";
import { captureHistoricalBranchRow } from "./historical-branch-row.js";

const { createDb } = await import("@meridian/database");
export const schema = await import("@meridian/database/schema");
const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
  "@meridian/database/__test-support__/db-fixtures"
);
const { createDrizzleNoticePort } = await import("../../notices/index.js");
export const {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  deferUntilDrizzleRollback,
  runAfterDrizzleCommit,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
  runOutsideWrite,
} = await import("../../../shared/drizzle-transaction.js");
export const { DOCUMENT_RUNTIME_RESET_TABLES, deleteDrizzleRows } = await import(
  "../../../test-support/drizzle-reset.js"
);
const {
  createDrizzleBranchJournalReadStore,
  createDrizzleWorkDraftPendingStore,
  createDrizzlePushCommitStore,
} = await import("../adapters/drizzle-branch-push.js");
const { createDrizzlePendingSettlementStore, stageSettlementBatchWithinTx } = await import(
  "../adapters/drizzle-pending-settlement.js"
);
const { createChangeTrailWorker } = await import("../adapters/change-trail-worker.js");
const { createDrizzleDraftTreeStep } = await import("../adapters/drizzle-draft-tree-step.js");
const { expirePendingSettlementClaims } = await import(
  "../../../test-support/settlement-claims.js"
);
const { createDraftPublication } = await import("../domain/draft-publication.js");
const { createDraftReviewItems } = await import("../domain/draft-review-items.js");
const { createTreeReader } = await import("../../context/tree/tree-view.js");
const { lockDocumentNamespaces } = await import(
  "../../context/adapters/context-fs/document-locations.js"
);
const { createDrizzleChangeTrailAggregateWriter } = await import(
  "../adapters/drizzle-change-trail-aggregate.js"
);
const { createDrizzleDocumentProjectionEffects } = await import(
  "../adapters/drizzle-document-activity.js"
);
const { createFixtureBranchStore } = await import("./fixture-branch-store.js");
const { ensureAndReadDocumentAuthorityHead, replaceDocumentAuthorityHeadGeneration } = await import(
  "../adapters/drizzle-document-authority-head.js"
);
const { createDrizzleCollabPersistence } = await import("../adapters/drizzle-journal.js");
const { createDeferredLiveProjectionCoordinator, createHocuspocusCoordinator } = await import(
  "../adapters/hocuspocus-coordinator.js"
);
const {
  createAgentEditObservabilityOptions,
  createBranchAgentEditDiagnostics,
  createDocumentProjectionDiagnostics,
  createReversalNoticeDiagnostics,
} = await import("../adapters/agent-edit-observability.js");
const { createAgentEditRuntime } = await import("../domain/agent-edit-runtime.js");
const { scopeAgentEdit } = await import("../domain/document-link-scope-doors.js");
const { createBranchConcurrentJournalWatermarks } = await import("../domain/branch-agent-edit.js");
const { createBranchCoordinator } = await import("../domain/branch-coordinator.js");
const { createBranchCriticalSections } = await import("../domain/branch-critical-sections.js");
const { createBranchPullService } = await import("../domain/branch-pulls.js");
const { createBranchPushService } = await import("../domain/branch-push.js");
const { DRAFT_TREE_STEP, encodeDraftTreePayload } = await import("../domain/draft-tree-payload.js");
const { fullStateFingerprint } = await import("../domain/branch-push-transition.js");
const { trailContributionReplacement } = await import("../domain/branch-trail-projection.js");
const { createDocumentWriteHookRunner } = await import(
  "../domain/document-projection-refresher.js"
);
const { enlistResponseParticipant, runResponseTransaction } = await import(
  "../domain/response-transaction.js"
);
const { createResponseWriteFinalizer } = await import("../domain/response-write-finalizer.js");
const { createPostDurabilityNoticeService } = await import("../domain/reversal-notices.js");
const { createDraftWriteVisibility } = await import("../domain/draft-write-visibility.js");
const { createDrizzleDraftWriteVisibilityStore } = await import(
  "../adapters/drizzle-draft-write-visibility.js"
);
const { createBranchThreadPeerAgentEditCore } = await import("../thread-peer-composition.js");
const { createWorkDraftReviewService } = await import("../domain/work-draft-review-service.js");
const { createMarkdownDocumentEngine } = await import("../domain/markdown-document.js");

/** Each suite owns its connection; importing this module allocates no database resources. */
export function createTestDatabase(): Database {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for DB tests");
  assertThrowawayDatabaseForRunDbTests(databaseUrl);
  return createDb(databaseUrl, { max: 4 });
}
const documentSchema = buildDocumentSchema();
const markupCodec = mdxCodec({
  schema: documentSchema,
});
const agentEditCodec = createAgentEditCodecFactory(markupCodec).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(documentSchema);

export const USER_ID = "00000000-0000-4000-8000-000000000801";
export const OTHER_USER_ID = "00000000-0000-4000-8000-000000000809";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
export const SOURCE_ID = "00000000-0000-4000-8000-000000000803";
export const WORK_ID = "00000000-0000-4000-8000-000000000804" as WorkId;
export const ALPHA_ID = "00000000-0000-4000-8000-000000000805" as DocumentId;
export const BETA_ID = "00000000-0000-4000-8000-000000000806" as DocumentId;
export const GAMMA_ID = "00000000-0000-4000-8000-000000000810" as DocumentId;
export const THREAD_ID = "00000000-0000-4000-8000-000000000807" as ThreadId;
export const TURN_ID = "00000000-0000-4000-8000-000000000808" as TurnId;

export const DEFAULT_SCENARIO_IDS = {
  PROJECT_ID,
  SOURCE_ID,
  WORK_ID,
  ALPHA_ID,
  BETA_ID,
  GAMMA_ID,
  THREAD_ID,
  TURN_ID,
};
export type ChangeTrailScenarioIds = typeof DEFAULT_SCENARIO_IDS;

export async function resetDatabase(db: Database): Promise<void> {
  // Clear the graph in this runner-owned disposable database using FK-ordered deletes.
  await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
  await seedDatabase(db);
}

/** Independent rows let warm and cold runs coexist without wiping durable evidence. */
export async function seedDatabase(
  db: Database,
  ids: ChangeTrailScenarioIds = DEFAULT_SCENARIO_IDS,
): Promise<void> {
  const { PROJECT_ID, SOURCE_ID, WORK_ID, ALPHA_ID, BETA_ID, GAMMA_ID, THREAD_ID, TURN_ID } = ids;
  await db
    .insert(schema.users)
    .values([
      conformanceUserValues(USER_ID, "response-atomicity"),
      conformanceUserValues(OTHER_USER_ID, "response-atomicity-other"),
    ])
    .onConflictDoNothing();
  await db.insert(schema.projects).values({
    id: PROJECT_ID,
    userId: USER_ID,
    name: "Atomicity",
    slug: `atomicity-${PROJECT_ID}`,
  });
  await db.insert(schema.works).values({
    id: WORK_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    name: "Atomicity work",
    slug: "atomicity-work",
  });
  // The Work already has its draft, as if an earlier write ensured it (contract §2.5):
  // a drafted read pulls its thread peers instead of reading live.
  await db.insert(schema.drafts).values({
    projectId: PROJECT_ID,
    originWorkId: WORK_ID,
    createdBy: USER_ID,
  });
  await db.insert(schema.contextSources).values({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    name: "Manuscript",
    slug: "manuscript",
    scope: "project",
    isPrimary: true,
  });
  await db.insert(schema.documents).values([
    {
      id: ALPHA_ID,
      contextSourceId: SOURCE_ID,
      name: "alpha",
      extension: "",
      fileType: "markdown",
    },
    {
      id: BETA_ID,
      contextSourceId: SOURCE_ID,
      name: "beta",
      extension: "",
      fileType: "markdown",
    },
    {
      id: GAMMA_ID,
      contextSourceId: SOURCE_ID,
      name: "third",
      extension: "md",
      fileType: "markdown",
    },
  ]);
  await db.insert(schema.threads).values({
    rootThreadId: THREAD_ID,
    id: THREAD_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Thread",
    kind: "primary",
    status: "idle",
    aiWriteMode: "draft",
  });
  await db.insert(schema.turns).values({
    id: TURN_ID,
    threadId: THREAD_ID,
    position: 1,
    role: "assistant",
    origin: "assistant",
    status: "complete",
  });
  await db.insert(schema.threadWorks).values({
    threadId: THREAD_ID,
    workId: WORK_ID,
    projectId: PROJECT_ID,
    isPrimary: true,
  });
}
export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end();
}

export function markdownFromUpdate(update: Uint8Array): string {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, update);
    return serializeMarkdown(doc);
  } finally {
    doc.destroy();
  }
}
export type ChangeTrailHarnessOptions = {
  ids?: ChangeTrailScenarioIds;
  /** Default: every grant is confirmed. */
  fileAccess?: import("../../file-policy/index.js").FileAccess;
  /** Default: a static scope, whose tokens ignore the tree. */
  links?: DocumentLinkScopes;
  afterDurableCommit?: (input: {
    documentIds: readonly DocumentId[];
    appendWriterPrefix(documentId: DocumentId, prefix: string): Promise<void>;
    deleteWriterPrefix(documentId: DocumentId, length: number): Promise<void>;
  }) => Promise<void>;
  /** After a batch member is classified, before its completion transaction opens. */
  afterClassification?: (input: {
    documentId: DocumentId;
    deleteWriterPrefix(documentId: DocumentId, length: number): Promise<void>;
  }) => Promise<void>;
  /** Inside the completion transaction, after every write, just before commit. */
  beforeCompletionCommit?: () => void;
  /** Inside the completion transaction, after each push's text is admitted (journal and projection). */
  afterAdmission?: (input: { documentId: DocumentId; ordinal: number }) => void | Promise<void>;
  /** Ahead-ref settlement at Apply's arrivals; absent, completions settle nothing. */
  arrivals?: DocumentArrivals;
  /** Inside a withdrawal (refusal or hold), at its first write. */
  duringWithdrawal?: () => Promise<void>;
  /** Publication steps after the draft tree step, in the order they run. */
  publicationSteps?: readonly SettlementPublicationStep[];
};

export function createHarness(db: Database, options: ChangeTrailHarnessOptions = {}) {
  // One link scope for every door the harness assembles, as composition shares one.
  const links = options.links ?? createStaticDocumentLinkScopes();
  const { ALPHA_ID, BETA_ID, GAMMA_ID, THREAD_ID, TURN_ID } = options.ids ?? DEFAULT_SCENARIO_IDS;
  const documentName = (documentId: DocumentId) =>
    documentId === ALPHA_ID ? "alpha" : documentId === GAMMA_ID ? "third" : "beta";
  const DRAFT_DESTINATION = {
    kind: "draft",
    workId: (options.ids ?? DEFAULT_SCENARIO_IDS).WORK_ID,
    workSlug: "atomicity-work",
  } as const;
  const persistence = createDrizzleCollabPersistence(db);
  const hocuspocus = fakeHocuspocus();
  const liveCoordinator = createHocuspocusCoordinator({
    hocuspocus: () => hocuspocus as never,
    journal: persistence.journal,
  });
  const branchCriticalSections = createBranchCriticalSections();
  const workDrafts = createDrafts({
    store: createDrizzleDraftStore(db),
    boundary: createDrizzleDraftWriteBoundary(db),
  });
  const realBranchStore = createFixtureBranchStore(db, {
    live: {
      journal: persistence.journal,
      lifecycle: persistence.lifecycle,
    },
    drafts: workDrafts,
  });
  let journalInsertCount = 0;
  // Which branch journal insert of the next save fails, counting from 1.
  const state = {
    failJournalInsertAt: null as number | null,
    failFirstRefresh: false,
    refreshedDocuments: [] as string[],
    refreshObservedDurability: false,
  };
  function injectSecondJournalFailure(): void {
    if (++journalInsertCount === state.failJournalInsertAt) {
      throw new Error(
        state.failJournalInsertAt === 2
          ? "injected second-document journal failure"
          : "injected branch journal failure",
      );
    }
  }
  const branchStore = {
    ...realBranchStore,
    async appendJournal(input: Parameters<NonNullable<typeof realBranchStore.appendJournal>>[0]) {
      injectSecondJournalFailure();
      return realBranchStore.appendJournal?.(input);
    },
    async commitBranchMutation(
      input: Parameters<NonNullable<typeof realBranchStore.commitBranchMutation>>[0],
    ) {
      if (input.journals?.length) injectSecondJournalFailure();
      return realBranchStore.commitBranchMutation?.(input) ?? false;
    },
  };
  const branchBroadcasts: string[] = [];
  const branchCoordinator = createBranchCoordinator({
    journalReads: createDrizzleBranchJournalReadStore(db),
    store: branchStore,
    criticalSections: branchCriticalSections,
    onBranchUpdate: ({ branchId }) => branchBroadcasts.push(branchId),
  });
  const { draftRebase } = draftRebaseDeps({
    journal: persistence.journal,
    branchCoordinator,
    branches: branchStore,
  });
  const realWatermarks = createBranchConcurrentJournalWatermarks();
  const pendingWatermarks = new Set<string>();
  const watermarkCommits: string[] = [];
  const watermarkKey = (threadId: ThreadId, documentId: DocumentId) => `${threadId}:${documentId}`;
  const watermarks = {
    current: realWatermarks.current,
    capturePending(threadId: ThreadId, documentId: DocumentId, id: number, attemptId?: string) {
      pendingWatermarks.add(watermarkKey(threadId, documentId));
      realWatermarks.capturePending(threadId, documentId, id, attemptId);
    },
    commitPending(threadId: ThreadId, documentId: DocumentId, attemptId?: string) {
      pendingWatermarks.delete(watermarkKey(threadId, documentId));
      watermarkCommits.push(watermarkKey(threadId, documentId));
      realWatermarks.commitPending(threadId, documentId, attemptId);
    },
    clearPending(threadId: ThreadId, documentId: DocumentId) {
      pendingWatermarks.delete(watermarkKey(threadId, documentId));
      realWatermarks.clearPending(threadId, documentId);
    },
  };
  const branchPulls = createBranchPullService({
    outsideTransaction: runOutsideWrite,
    rootTransaction: (operation) => runInRootDrizzleTransaction(db, operation),
    liveCoordinator,
    branchCoordinator,
    branches: branchStore,
    concurrentJournalWatermarks: watermarks,
    draftRebase,
  });
  const notices = createDrizzleNoticePort(db);
  const changeTrails = createDrizzleChangeTrailAggregateWriter(db);
  const durableProjectionSerializer = createMarkdownDocumentEngine({
    links,
    model,
    codec: markupCodec,
    journal: persistence.journal,
    coordinator: liveCoordinator,
    lifecycle: persistence.lifecycle,
    initialDocumentSeeds: persistence.lifecycle,
    metaForOrigin: () => ({ origin: "system", seq: 0 }),
    identityPreservingWrite: async () => {
      throw new Error("Identity-preserving writes are not part of this harness");
    },
    resolveFiletype: async (documentId) => {
      const [row] = await db
        .select({ filetype: schema.documents.fileType })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentId));
      return row?.filetype ?? null;
    },
  });
  const durableBranchJournalReadStore = createDrizzleBranchJournalReadStore(db);
  const durablePushCommitStore = createDrizzlePushCommitStore(
    db,
    stageSettlementBatchWithinTx,
    changeTrails,
    notices,
  );
  const durableWorkDraftPendingStore = createDrizzleWorkDraftPendingStore(db);
  const events: Array<{
    name: string;
    level: string;
    payload: Record<string, unknown>;
    correlation?: object;
  }> = [];
  let preCommitBranchHashes: Array<{ id: string; state: string; stateVector: string }> = [];
  const eventSink: import("../../observability/index.js").EventSink = {
    emit(event) {
      events.push({
        name: event.name,
        level: event.level,
        payload: event.payload,
        correlation: event.correlation,
      });
    },
    emitBatch(batch) {
      for (const event of batch)
        events.push({
          name: event.name,
          level: event.level,
          payload: event.payload,
          correlation: event.correlation,
        });
    },
    flush: async () => {},
  };
  const durableSettlementStore = createDrizzlePendingSettlementStore(
    db,
    durableProjectionSerializer,
    admissionProbe(createDrizzleDocumentProjectionEffects(db), options.afterAdmission),
    changeTrails,
    createDrizzleDocumentDerivationStore(db, createDocumentLastAddress(db)),
    {
      ...notices,
      // Withdrawal's first write: a refused or held member's notices are retracted.
      async retractForPushes(pushIds) {
        await options.duringWithdrawal?.();
        return notices.retractForPushes(pushIds);
      },
    },
    eventSink,
    {
      // The real sorted acquisition, as composition's arrivals adapter takes it.
      namespaces: {
        lockNamespaces: ({ documentIds, sourceIds }) =>
          lockDocumentNamespaces(db, documentIds, sourceIds),
      },
      steps: [
        createDrizzleDraftTreeStep(db, {
          drafts: workDrafts,
          // The harness publishes no Work projection; pending changes just run.
          workProjection: { mutatePendingDraft: (_draftIds, operation) => operation() },
          // The harness keeps no catalog.
          catalog: { refreshSources: async () => "" },
          ...(options.arrivals ? { arrivals: options.arrivals } : {}),
        }),
        ...(options.publicationSteps ?? []),
      ],
    },
    branchStore,
  );
  const appendWriterPrefix = async (documentId: DocumentId, prefix: string) => {
    const doc = hocuspocus.documents.get(documentId);
    if (!doc) throw new Error("warm live document is unavailable after push commit");
    const block = model.getBlocks(toDocHandle(doc))[0];
    if (!block) throw new Error("writer target is unavailable after push commit");
    const before = Y.encodeStateVector(doc);
    model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, prefix);
    await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  };
  const deleteWriterPrefix = async (documentId: DocumentId, length: number) => {
    const doc = hocuspocus.documents.get(documentId);
    if (!doc) throw new Error("warm live document is unavailable after push commit");
    const block = model.getBlocks(toDocHandle(doc))[0];
    if (!block) throw new Error("writer target is unavailable after push commit");
    const before = Y.encodeStateVector(doc);
    model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: length }, "");
    await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
      origin: `human:${USER_ID}`,
      seq: 0,
    });
  };
  const settlementStore: typeof durableSettlementStore = {
    ...durableSettlementStore,
    async completeBatch(input) {
      for (const member of input.members) {
        await options.afterClassification?.({
          documentId: member.push.documentId,
          deleteWriterPrefix,
        });
      }
      return durableSettlementStore.completeBatch({
        ...input,
        recheck(cuts) {
          const decision = input.recheck(cuts);
          options.beforeCompletionCommit?.();
          return decision;
        },
      });
    },
  };
  const realBranchPush = createBranchPushService({
    links,
    changeEventDelivery: {
      deliver() {},
    },
    branchStore,
    criticalSections: branchCriticalSections,
    journalReadStore: durableBranchJournalReadStore,
    commitStore: durablePushCommitStore,
    settlementStore,
    branchCoordinator,
    draftRebase,
    liveCoordinator,
    model,
    codec: createAgentEditCodecFactory(markupCodec),
    resolveDocumentTitle: async (documentId) => {
      return documentName(documentId);
    },
    hooks: options.afterDurableCommit
      ? {
          afterDurableCommit: async (documentIds) =>
            options.afterDurableCommit?.({
              documentIds,
              appendWriterPrefix,
              deleteWriterPrefix,
            }),
        }
      : undefined,
  });
  const deliveredEvents: unknown[] = [];
  const trailDelivery = createChangeTrailWorker({
    db,
    journalWriter: {
      async appendEvent(_threadId: string, event: unknown) {
        deliveredEvents.push(event);
        return deliveredEvents.length;
      },
    } as never,
    eventHub: { invalidateCommittedJournal() {} },
  });
  const resolveDocumentUri = async (documentId: string) =>
    `manuscript/${documentName(documentId as DocumentId)}.md`;
  const projectionDiagnostics = createDocumentProjectionDiagnostics(eventSink);
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: async () => {},
    diagnostics: projectionDiagnostics,
  });
  const observability = createAgentEditObservabilityOptions({ eventSink });
  const modelDocumentEdits = createModelDocumentEdits({
    service: () => turnInverse,
    branches: branchStore,
    coordinator: liveCoordinator,
  });
  const runtime = createAgentEditRuntime({
    documentEdits: modelDocumentEdits,
    links,
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    journal: persistence.journal,
    coordinator: liveCoordinator,
    agentCoordinator: createDeferredLiveProjectionCoordinator({
      hocuspocus: () => hocuspocus as never,
      journal: persistence.journal,
      live: liveCoordinator,
      transactions: {
        inTransaction: isInDrizzleTransaction,
        outsideTransaction: runOutsideDrizzleTransaction,
        afterCommit: deferUntilDrizzleCommit,
      },
    }),
    lifecycle: persistence.lifecycle,
    initialDocumentSeeds: persistence.lifecycle,
    runDocumentWriteHook,
    resolveDocumentFiletype: async () => null,
    observability,
    inTransaction: isInDrizzleTransaction,
  });
  const projections = {
    // Records each post-commit refresh so a test can prove one failure skips no later document.
    async refresh(...args: Parameters<typeof runDocumentWriteHook>) {
      state.refreshedDocuments.push(args[0].documentId);
      if (state.failFirstRefresh && state.refreshedDocuments.length === 1) {
        const rows = await db
          .select()
          .from(schema.branchWriteJournal)
          .where(eq(schema.branchWriteJournal.source, "agent"));
        state.refreshObservedDurability = rows.length > 0 && !isInDrizzleTransaction();
        throw new Error("injected post-root-commit refresh failure");
      }
      return runDocumentWriteHook(...args);
    },
  };
  // Scoped as composition scopes it, so a real link scope sees every model call.
  const agentEdit = scopeAgentEdit(
    createBranchThreadPeerAgentEditCore({
      documentEdits: modelDocumentEdits,
      drafts: workDrafts,
      fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
      lockWorks: async () => {},
      lockLiveDocuments: async () => {},
      liveUtilityCore: runtime.liveUtilityCore,
      journal: persistence.journal,
      lifecycle: persistence.lifecycle,
      branches: branchStore,
      branchCoordinator,
      criticalSections: branchCriticalSections,
      hiddenDocumentIds: (ids) => hiddenDocumentIds(db, ids),
      branchPulls,
      branchJournal: durableBranchJournalReadStore,
      concurrentJournalWatermarks: watermarks,
      diagnostics: createBranchAgentEditDiagnostics(eventSink),
      afterCommit: runAfterDrizzleCommit,
      enlistResponseParticipant,
      model: runtime.model,
      codec: runtime.codec,
      links,
      aheadRefs: UNSUPPORTED_AHEAD_REFS,
      semanticProvenance: runtime.semanticProvenance,
      observability,
      commitThreadResponseAtomically: (operation) => runInDrizzleTransaction(db, operation),
      responseTransactionSettlement: {
        deferUntilCommit: deferUntilDrizzleCommit,
        deferUntilRollback: deferUntilDrizzleRollback,
      },
      responseTransactions: {
        enlist: enlistResponseParticipant,
        run: runResponseTransaction,
      },
    }),
    links,
  );
  const turnInverse = createDrizzleTurnInverseService({
    db,
    journal: persistence.journal,
    branches: branchStore,
    coordinator: liveCoordinator,
    branchCoordinator,
    criticalSections: branchCriticalSections,
    resolveDocumentUri,
    refreshDocument: (documentId) => projections.refresh({ documentId }),
    flushLivePull: branchPulls.flushLivePull,
    workProjection: { mutatePendingBranches: (_branchIds, operation) => operation() },
  });
  const responseFinalizer = createResponseWriteFinalizer({
    agentEdit,
    rollback: turnInverse,
    projections,
    notices: createPostDurabilityNoticeService({
      notices,
      documentUriResolver: resolveDocumentUri,
      diagnostics: createReversalNoticeDiagnostics(eventSink),
    }),
    visibility: createDraftWriteVisibility({
      store: createDrizzleDraftWriteVisibilityStore({ db, branches: branchStore }),
      notices,
      resolveDocumentName: async (documentId) => documentId,
      diagnostics: createReversalNoticeDiagnostics(eventSink),
    }),
  });
  const reviewItems = createDraftReviewItems({
    tree: createTreeReader(db),
    branches: (draftId, documentIds) =>
      durableWorkDraftPendingStore.listDraftBranchEvidence(draftId, documentIds),
    creators: (draftId, documentIds) =>
      durableWorkDraftPendingStore.listCreators(draftId, documentIds),
    settling: (draftId) => durableWorkDraftPendingStore.listSettling(draftId),
  });
  // The harness keeps no branch rooms but the fake hocuspocus's: retirement closes those and
  // the pooled cores' thread state.
  const retirePeers = createPeerRetirement({
    closeBranchRoom: (branchId) => {
      for (const roomId of [...hocuspocus.documents.keys()]) {
        if (!roomId.startsWith(`branch:${branchId}:gen:`)) continue;
        hocuspocus.documents.get(roomId)?.destroy();
        hocuspocus.documents.delete(roomId);
      }
    },
    agentEdit,
  });
  const lookups = createDrizzleCollabLookups(db);
  const identity = createDraftReviewIdentity({ drafts: workDrafts, reviewItems });
  const draftCommands = createDrizzleDraftCommands(db);
  const drafts = createWorkDraftReviewService({
    drafts: workDrafts,
    reviewItems,
    pending: durableWorkDraftPendingStore,
    identity,
    discard: createDraftDiscard({
      drafts: workDrafts,
      draftLeases: createDraftBranchLeases({
        branches: branchStore,
        criticalSections: branchCriticalSections,
      }),
      criticalSections: branchCriticalSections,
      // No Work projection in this harness: pending counts aren't under test.
      store: createDrizzleDraftDiscard(db, {
        drafts: workDrafts,
        workProjection: { mutatePendingDraft: (_draftIds, operation) => operation() },
        catalog: { refreshSources: async () => "" },
      }),
      retire: retirePeers,
      releaseObjects: async () => {},
    }),
    commands: draftCommands,
    attribution: createDraftAttribution(createDrizzleDraftAttributionStore(db)),
    resolveThreadTitles: lookups.resolveThreadTitles,
    publication: createDraftPublication({
      drafts: workDrafts,
      identity,
      commands: draftCommands,
      push: realBranchPush,
    }),
  });
  // Tests mint a destination grant without a target; a write's grant names its document.
  const grantedAgentEdit = new Proxy(agentEdit, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "write" || typeof value !== "function") return value;
      return (command: { documentId?: string }, context: { grant: FileGrant<"edit"> }) =>
        value.call(
          target,
          command,
          command.documentId
            ? {
                ...context,
                grant: {
                  ...context.grant,
                  facts: {
                    ...context.grant.facts,
                    target: { kind: "document", documentId: command.documentId },
                  },
                },
              }
            : context,
        );
    },
  });
  const collab = {
    agentEdit: () => grantedAgentEdit,
    writeDocument: runtime.markdownDocuments.writeDocument,
    bindMarkdown: runtime.linkBinder.bindMarkdown,
    ...responseFinalizer,
    ...drafts,
  };

  /**
   * Stages one write each to alpha and beta in one reply, both drafted. With
   * `liveBeta`, beta's write goes live and is staged first, so a save that
   * fails at alpha's branch journal fails after beta's live append ran. A live
   * write records its authoring response, so `responseId` must then be a UUID.
   */
  async function seedAndStage(responseId: string, options: { liveBeta?: boolean } = {}) {
    await writeMarkdown(collab, {
      documentId: ALPHA_ID,
      markdown: "Alpha base.",
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    await writeMarkdown(collab, {
      documentId: BETA_ID,
      markdown: "Beta base.",
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    const context = {
      sessionId: THREAD_ID,
      grant: testFileGrant(DRAFT_DESTINATION),
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    };
    // Establish thread peers first, then append a real concurrent work-draft row.
    // The following staged write must capture that row as a pending watermark.
    await collab
      .agentEdit()
      .read(
        { file: "alpha.md", documentId: ALPHA_ID },
        { ...context, responseIdentity: undefined },
      );
    if (options.liveBeta) {
      await db.insert(schema.modelResponses).values({
        id: responseId as never,
        turnId: TURN_ID,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
    }
    const betaContext = options.liveBeta
      ? { ...context, grant: testFileGrant({ kind: "live" }) }
      : context;
    await collab
      .agentEdit()
      .read(
        { file: "beta.md", documentId: BETA_ID },
        { ...betaContext, responseIdentity: undefined },
      );
    for (const documentId of options.liveBeta ? [ALPHA_ID] : [ALPHA_ID, BETA_ID]) {
      const draft = await branchStore.resolveWorkDraftBranchForThread(documentId, THREAD_ID);
      const last = model.getBlocks(toDocHandle(draft.doc)).at(-1) ?? null;
      model.insertBlocks(toDocHandle(draft.doc), last, markupCodec.parse("Writer concurrent."));
      await commitSegmentRows(branchCoordinator, {
        branchId: draft.branchId,
        sourceDoc: draft.doc,
        rows: [
          {
            branchId: draft.branchId,
            updateData: await captureHistoricalBranchRow(
              branchCoordinator,
              draft.branchId,
              draft.doc,
            ),
            source: "writer",
            actorUserId: USER_ID as never,
            threadId: THREAD_ID,
            turnId: null,
            wId: null,
            updateMeta: null,
          },
        ],
      });
      draft.doc.destroy();
    }
    const stageAlpha = () =>
      expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "alpha.md",
            documentId: ALPHA_ID,
            content: "Agent alpha.",
          },
          context,
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
    const stageBeta = () =>
      expect(
        collab
          .agentEdit()
          .write(
            { command: "insert", file: "beta.md", documentId: BETA_ID, content: "Agent beta." },
            betaContext,
          ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
    if (options.liveBeta) {
      await stageBeta();
      await stageAlpha();
    } else {
      await stageAlpha();
      await stageBeta();
    }
    preCommitBranchHashes = await databaseBranchHashes();
    // Staging pulls legitimately publish into loaded branch rooms. Start the
    // measurement window after staging so it covers only the commit attempt.
    branchBroadcasts.length = 0;
    watermarkCommits.length = 0;
    hocuspocus.broadcasts.length = 0;
    const workDrafts = await db
      .select({ id: schema.documentBranches.id })
      .from(schema.documentBranches)
      .where(eq(schema.documentBranches.kind, "work_draft"));
    return workDrafts.map((branch) => branch.id).sort();
  }

  async function seedAndStageDestructive(
    responseId: string,
    documentId: DocumentId = ALPHA_ID,
    journalWriterEdit = true,
    markdown = "Alpha base.\n\nWriter block.",
    writerBlockIndex = 1,
    writerEditBeforeWrite = false,
    sameIdentityRewrite = false,
  ) {
    const file = `${documentName(documentId)}.md`;
    await writeMarkdown(collab, {
      documentId,
      markdown,
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    const context = {
      sessionId: THREAD_ID,
      grant: testFileGrant(DRAFT_DESTINATION),
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
      createdDocument: false,
    };
    await collab
      .agentEdit()
      .read({ file, documentId }, { ...context, responseIdentity: undefined });
    if (writerEditBeforeWrite) {
      await db.insert(schema.modelResponses).values({
        id: responseId as never,
        turnId: TURN_ID,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
    }
    const applyWriterEdit = () =>
      liveCoordinator.withDocument(documentId, async (doc) => {
        const writerBlock = model.getBlocks(toDocHandle(doc))[writerBlockIndex];
        if (!writerBlock) throw new Error("writer block missing before concurrent edit");
        const before = Y.encodeStateVector(doc);
        model.applyTextEdit(
          toDocHandle(doc),
          writerBlock,
          { from: 0, to: 0 },
          "Writer concurrent edit: ",
        );
        if (journalWriterEdit) {
          await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
            origin: `human:${USER_ID}`,
            seq: 0,
          });
        }
      });
    // The probe edit lands after the response's read but before the destructive
    // tool call. Journaled fixtures retain their older phase-C timing.
    if (writerEditBeforeWrite) {
      await applyWriterEdit();
    }
    await expect(
      collab.agentEdit().write(
        sameIdentityRewrite
          ? {
              command: "replace",
              file,
              documentId,
              find: writerEditBeforeWrite ? `Writer concurrent edit: ${markdown}` : markdown,
              content: "Agent replacement.",
            }
          : {
              command: "create",
              file,
              documentId,
              content: "# Agent replacement",
              overwrite: true,
            },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    if (!writerEditBeforeWrite) await applyWriterEdit();
    const workDraft = await branchStore.resolveWorkDraftBranchForThread(documentId, THREAD_ID);
    workDraft.doc.destroy();
    return workDraft.branchId;
  }

  async function seedDestructivePush(
    responseId: string,
    documentId: DocumentId = ALPHA_ID,
    replace = false,
  ): Promise<string> {
    await persistence.lifecycle.ensureDocument(documentId);
    await liveCoordinator.withDocument(documentId, async (doc) => {
      const before = Y.encodeStateVector(doc);
      model.insertBlocks(
        toDocHandle(doc),
        null,
        markupCodec.parse("Writer captured body.\n\nSurvivor."),
      );
      await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    const context = {
      grant: testFileGrant(DRAFT_DESTINATION),
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    };
    const file = `${documentName(documentId)}.md`;
    await collab
      .agentEdit()
      .read({ file, documentId }, { ...context, responseIdentity: undefined });
    const branch = await branchStore.resolveWorkDraftBranchForThread(documentId, THREAD_ID);
    const doomed = model.getBlocks(toDocHandle(branch.doc))[0];
    if (!doomed) throw new Error("draft block missing before destructive push");
    model.deleteBlock(toDocHandle(branch.doc), doomed);
    if (replace) {
      model.insertBlocks(toDocHandle(branch.doc), null, markupCodec.parse("Agent replacement."));
    }
    const committed = await commitSegmentRows(branchCoordinator, {
      branchId: branch.branchId,
      sourceDoc: branch.doc,
      rows: [
        {
          branchId: branch.branchId,
          updateData: await captureHistoricalBranchRow(
            branchCoordinator,
            branch.branchId,
            branch.doc,
          ),
          source: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: null,
          updateMeta: null,
        },
      ],
    });
    branch.doc.destroy();
    if (!committed) throw new Error("destructive draft edit did not commit");
    await liveCoordinator.withDocument(documentId, async (doc) => {
      const block = model.getBlocks(toDocHandle(doc))[0];
      if (!block) throw new Error("live writer block missing");
      const before = Y.encodeStateVector(doc);
      model.applyTextEdit(toDocHandle(doc), block, { from: 0, to: 0 }, "Writer recent: ");
      await persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    return branch.branchId;
  }

  async function seedWriterDocument(markdown: string, responseId: string): Promise<void> {
    await persistence.lifecycle.ensureDocument(ALPHA_ID);
    await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const before = Y.encodeStateVector(doc);
      replaceMarkdown(doc, markdown);
      await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: `human:${USER_ID}`,
        seq: 0,
      });
    });
    await collab.agentEdit().read(
      { file: "alpha.md", documentId: ALPHA_ID },
      {
        grant: testFileGrant(DRAFT_DESTINATION),
        sessionId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
      },
    );
  }

  /** Runs an agent command through the certified semantic-mutation admission path. */
  async function stageCertifiedReplace(input: {
    responseId: string;
    find: string;
    content: string;
  }): Promise<string> {
    // Resolving the draft branch creates it before the write.
    const branch = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
    branch.doc.destroy();
    const context = {
      sessionId: THREAD_ID,
      grant: testFileGrant(DRAFT_DESTINATION),
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseIdentity: { providerResponseId: input.responseId, editScopeId: input.responseId },
    };
    await expect(
      collab.agentEdit().write(
        {
          command: "replace",
          file: "alpha.md",
          documentId: ALPHA_ID,
          find: input.find,
          content: input.content,
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "success", phase: "staged" });
    await expect(
      collab.finalizeResponseCommit(
        { providerResponseId: input.responseId, editScopeId: input.responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      ),
    ).resolves.toMatchObject({ status: "committed" });
    return branch.branchId;
  }

  /**
   * Apply the whole of each branch's item as one writer command, as the draft routes do: the
   * command rides in an empty tree payload, which settles it with the member outcomes. Callers
   * may add the publication payloads of their own steps.
   */
  async function applyBranches(
    branchIds: readonly string[],
    payloads: Readonly<Record<string, JsonValue>> = {},
  ) {
    const snapshots = await Promise.all(branchIds.map((id) => branchStore.getBranch(id)));
    const first = snapshots[0];
    if (!first?.workId || !first.draftId)
      throw new Error("the branches to apply belong to no draft");
    const draftId = first.draftId;
    const tree = (decided: readonly DraftDecidedOutcome[]) => ({
      ...payloads,
      [DRAFT_TREE_STEP]: encodeDraftTreePayload({
        draftId,
        command: { shape: "all", itemKeys: [], decided: [...decided] },
        items: [],
      }),
    });
    const pushed = await realBranchPush.pushBranchesToLive({
      members: branchIds.map((branchId) => ({
        branchId,
        itemKey: branchId,
        request: { scope: "item" as const },
      })),
      payloads: tree([]),
      finalizePayloads: tree,
      command: {
        commandId: crypto.randomUUID() as never,
        workId: first.workId,
        accountId: USER_ID as UserId,
        kind: "apply_items",
        draftId,
        digest: crypto.randomUUID(),
      },
      pushedByUserId: USER_ID as UserId,
    });
    return pushed.refused
      ? { status: "refused" as const, refused: pushed.refused }
      : { status: "pushed" as const };
  }

  /** The staged bytes as each member's own replan: what a probe completing directly settles with. */
  function stagedReplans(
    members: readonly {
      push: { id: number };
      pushUpdate: Uint8Array;
      trail: Parameters<typeof trailContributionReplacement>[0];
    }[],
  ) {
    return new Map(
      members.map((member) => [
        member.push.id,
        {
          pushId: member.push.id,
          outcome: {
            status: "applied" as const,
            pushUpdate: member.pushUpdate,
            trail: member.trail,
            overrode: [],
          },
          base: { kind: "none" as const },
        },
      ]),
    );
  }

  async function branchesByKind(kind: "thread_peer" | "work_draft") {
    return db.select().from(schema.documentBranches).where(eq(schema.documentBranches.kind, kind));
  }

  async function markdownByKind(kind: "thread_peer" | "work_draft") {
    const rows = await branchesByKind(kind);
    return Promise.all(
      rows
        .sort((left, right) => left.documentId.localeCompare(right.documentId))
        .map((row) => branchCoordinator.readBranch(row.id, async (doc) => serializeMarkdown(doc))),
    );
  }

  return {
    set failFirstRefresh(value: boolean) {
      state.failFirstRefresh = value;
    },
    get refreshObservedDurability() {
      return state.refreshObservedDurability;
    },
    get refreshedDocuments() {
      return [...state.refreshedDocuments];
    },
    get failSecondJournalInsert() {
      return state.failJournalInsertAt === 2;
    },
    set failSecondJournalInsert(value: boolean) {
      this.failJournalInsertAt = value ? 2 : null;
    },
    get failJournalInsertAt() {
      return state.failJournalInsertAt;
    },
    set failJournalInsertAt(value: number | null) {
      state.failJournalInsertAt = value;
      journalInsertCount = 0;
    },
    seedAndStage,
    seedAndStageDestructive,
    seedProbeTimelineSweep: (responseId: string, documentId: DocumentId = ALPHA_ID) =>
      seedAndStageDestructive(
        responseId,
        documentId,
        true,
        "Alpha base.\n\n---\n\nWriter block.\n\n---\n\nGamma.",
        2,
        true,
      ),
    seedProbeTimelineAfterRead: (responseId: string, documentId: DocumentId = ALPHA_ID) =>
      seedAndStageDestructive(
        responseId,
        documentId,
        true,
        "Alpha base.\n\n---\n\nWriter block.\n\n---\n\nGamma.",
        2,
        true,
      ),
    push: (branchId: string) => applyBranches([branchId]),
    pushBranches: (branchIds: readonly string[], payloads?: Readonly<Record<string, JsonValue>>) =>
      applyBranches(branchIds, payloads),
    seedDestructivePush,
    seedWriterDocument,
    stageCertifiedReplace,
    /** A writer edit on the warm room, journaled first, as a socket write would be. */
    appendWriterPrefix,
    /** The process's branch critical sections, for lease probes. */
    criticalSections: branchCriticalSections,
    /** The warm room's full-state fingerprint, as a text token captures it. */
    liveFingerprint: (documentId: DocumentId) =>
      liveCoordinator.withDocument(documentId, async (doc) => fullStateFingerprint(doc)),
    /**
     * Expires the pending batch's lease inside the caller's transaction (completion or
     * abandonment holds the row), as if the database clock passed it there.
     */
    expireLeaseInTransaction: () => expirePendingSettlementClaims(db),
    /** A completion of the current owner's valid batch, attempted inside an ambient transaction. */
    async attemptAmbientCompletion() {
      const [batch] = await db
        .select()
        .from(schema.branchPushSettlementBatches)
        .where(eq(schema.branchPushSettlementBatches.state, "pending"));
      if (!batch?.claimToken) throw new Error("the probe needs an owned pending batch");
      const owner = { token: batch.claimToken, epoch: batch.claimEpoch };
      const loaded = await durableSettlementStore.loadSettlementBatch({ batchId: batch.id, owner });
      if (!loaded) throw new Error("the owner lost its batch");
      return runInRootDrizzleTransaction(db, () =>
        durableSettlementStore.completeBatch({
          batchId: batch.id,
          claim: loaded.claim,
          members: loaded.members.map((member) => ({
            push: member.push,
            joinVersion: member.joinVersion,
            trail: member.trail,
            replacement: trailContributionReplacement(member.trail, member.push),
          })),
          payloads: loaded.payloads,
          leasedBranchIds: [],
          replanned: stagedReplans(loaded.members),
          recheck: () => "commit",
          afterCommit() {},
        }),
      ).then(
        () => "completed",
        (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
      );
    },
    crossWorkProbeFixture: () => ({
      runtime,
      links,
      branchPulls,
      branchPush: realBranchPush,
      db,
      schema,
      persistence,
      liveCoordinator,
      collab,
      branchStore,
      branchCoordinator,
      realBranchPush,
      draftMarkdown: (branchId: string) =>
        branchCoordinator.readBranch(branchId, async (doc) => serializeMarkdown(doc)),
      trailDelivery,
      hocuspocus,
      model,
      markupCodec,
      agentEditCodec,
      deliveredEvents,
    }),
    pollTrails: () => trailDelivery.drain(),
    /** Stops debounced live pulls (scheduled by AI live commits) leaking into later tests. */
    cancelScheduledPulls: () => branchPulls.cancelScheduledPulls(),
    async stageAnotherDestructiveEdit(branchId: string) {
      const staged = await branchCoordinator.readBranch(branchId, async (doc) => {
        const stagedDoc = new Y.Doc({ gc: false });
        Y.applyUpdate(stagedDoc, Y.encodeStateAsUpdate(doc));
        return { doc: stagedDoc };
      });
      try {
        const doc = staged.doc;
        const block = model.getBlocks(toDocHandle(doc))[0];
        if (!block) throw new Error("draft block missing before subsequent edit");
        model.deleteBlock(toDocHandle(doc), block);
        await commitSegmentRows(branchCoordinator, {
          branchId: branchId,
          sourceDoc: doc,
          rows: [
            {
              branchId: branchId,
              updateData: await captureHistoricalBranchRow(branchCoordinator, branchId, doc),
              source: "agent",
              actorUserId: null,
              threadId: THREAD_ID,
              turnId: TURN_ID,
              wId: null,
              updateMeta: null,
            },
          ],
        });
      } finally {
        staged.doc.destroy();
      }
    },
    markTurnError: () =>
      db.update(schema.turns).set({ status: "error" }).where(eq(schema.turns.id, TURN_ID)),
    rollbackResponse: (responseId: string) =>
      collab.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        { threadId: THREAD_ID, turnId: TURN_ID },
      ),
    recoverPendingLiveSettlements: () => realBranchPush.recoverPendingLiveSettlements(),
    /**
     * Drives every ownership-fenced settlement operation with a stale claim and
     * otherwise valid input: the current owner's batch, members and join versions.
     */
    async probeStaleSettlementClaim(claim: {
      token: string;
      epoch: number;
      kind: "warm" | "recovery";
      leaseExpiresAt: Date;
    }) {
      const [row] = await db
        .select()
        .from(schema.branchPushSettlementOutbox)
        .where(eq(schema.branchPushSettlementOutbox.documentId, ALPHA_ID));
      if (!row) throw new Error("settlement row is unavailable");
      const [owner] = await db
        .select()
        .from(schema.branchPushSettlementBatches)
        .where(eq(schema.branchPushSettlementBatches.id, row.batchId));
      if (!owner?.claimToken) throw new Error("the probe needs a current owner");
      const batch = await durableSettlementStore.loadSettlementBatch({
        batchId: row.batchId,
        owner: { token: owner.claimToken, epoch: owner.claimEpoch },
      });
      if (!batch) throw new Error("the current owner lost its batch");
      const liveRows = async () =>
        (
          await db
            .select({ id: schema.documentYjsUpdates.id })
            .from(schema.documentYjsUpdates)
            .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID))
        ).length;
      const liveRowsBefore = await liveRows();
      let completionCallbackRan = false;
      let afterCommitRan = false;
      const renewed = await durableSettlementStore.renewClaim({ batchId: row.batchId, claim });
      const failureRecorded = await durableSettlementStore.recordFailure({
        batchId: row.batchId,
        claim,
        stage: "execute",
        error: "stale actor A failure",
      });
      const completion = await durableSettlementStore.completeBatch({
        batchId: row.batchId,
        claim,
        members: batch.members.map((member) => ({
          push: member.push,
          joinVersion: member.joinVersion,
          trail: member.trail,
          replacement: trailContributionReplacement(member.trail, member.push),
        })),
        payloads: batch.payloads,
        leasedBranchIds: [],
        replanned: stagedReplans(batch.members),
        recheck() {
          completionCallbackRan = true;
          return "commit";
        },
        afterCommit() {
          afterCommitRan = true;
        },
      });
      return {
        renewed,
        failureRecorded,
        completion: completion.status,
        completionCallbackRan,
        afterCommitRan,
        liveRowsUnchanged: (await liveRows()) === liveRowsBefore,
      };
    },
    async attemptSnapshotReplacement() {
      const [checkpoint] = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, ALPHA_ID))
        .limit(1);
      if (!checkpoint) throw new Error("durable authority checkpoint is unavailable");
      const authorityHead = await ensureAndReadDocumentAuthorityHead(db, ALPHA_ID);
      return replaceDocumentAuthorityHeadGeneration(db, {
        documentId: ALPHA_ID,
        checkpointId: checkpoint.id,
        expectedGeneration: authorityHead.generation,
      });
    },
    destroyWarmState() {
      for (const doc of hocuspocus.documents.values()) doc.destroy();
      hocuspocus.documents.clear();
      hocuspocus.broadcasts.length = 0;
    },
    liveMarkdown: (documentId: DocumentId) =>
      liveCoordinator.withDocument(documentId, async (doc) => serializeMarkdown(doc)),
    pushRows: () => db.select().from(schema.pushLineage),
    liveUpdateCount: async () => (await db.select().from(schema.documentYjsUpdates)).length,
    activePushJournalCount: async () =>
      (
        await db
          .select()
          .from(schema.branchWriteJournal)
          .where(eq(schema.branchWriteJournal.status, "active"))
      ).length,
    async makeJournalOwnershipMixed() {
      const [owned] = await db
        .select()
        .from(schema.branchWriteJournal)
        .where(eq(schema.branchWriteJournal.status, "active"));
      if (!owned) throw new Error("missing owned journal row");
      await db.insert(schema.branchWriteJournal).values({
        branchId: owned.branchId,
        wId: owned.wId,
        source: owned.source,
        threadId: owned.threadId,
        turnId: null,
        actorUserId: owned.actorUserId,
        updateData: owned.updateData,
        draftBaseUpdateSeq: owned.draftBaseUpdateSeq,
        updateMeta: owned.updateMeta,
      });
    },
    async makeJournalOwnershipNull() {
      await db
        .update(schema.branchWriteJournal)
        .set({ turnId: null })
        .where(eq(schema.branchWriteJournal.status, "active"));
    },
    hardDeleteDocument: (documentId: DocumentId) =>
      db.delete(schema.documents).where(eq(schema.documents.id, documentId)),
    async hardDeleteThread() {
      await db.delete(schema.turns).where(eq(schema.turns.threadId, THREAD_ID));
      await db.delete(schema.threads).where(eq(schema.threads.id, THREAD_ID));
    },
    commit: (responseId: string) =>
      collab.finalizeResponseCommit(
        { providerResponseId: responseId, editScopeId: responseId },
        { threadId: THREAD_ID, turnId: TURN_ID },
      ),
    afterCommitEffects: () => ({
      branchBroadcasts: [...branchBroadcasts].sort(),
      watermarkCommits: [...watermarkCommits].sort(),
    }),
    openRoomIds: () => [...hocuspocus.documents.keys()].sort(),
    liveRoomBroadcasts: () => [...hocuspocus.broadcasts],
    /** Agent-origin live journal rows for a document. */
    async liveAgentUpdateCount(documentId: DocumentId) {
      const rows = await db
        .select({ id: schema.documentYjsUpdates.id })
        .from(schema.documentYjsUpdates)
        .where(
          and(
            eq(schema.documentYjsUpdates.documentId, documentId),
            eq(schema.documentYjsUpdates.originType, "agent"),
          ),
        );
      return rows.length;
    },
    stagedUpdates: (responseId: string) => [
      collab.agentEdit().hasResponseDocument(responseId, ALPHA_ID) ? [ALPHA_ID] : [],
      collab.agentEdit().hasResponseDocument(responseId, BETA_ID) ? [BETA_ID] : [],
    ],
    pendingWatermarkDocuments: () => [...pendingWatermarks].sort(),
    eventsNamed: (name: string) => events.filter((event) => event.name === name),
    responseEvents: (responseId: string) =>
      events
        .filter((event) => event.payload.responseId === responseId)
        .map((event) => ({
          transition: event.name.replace("response_committer.", ""),
          phase: event.payload.phase,
        })),
    responseJournalRows: () =>
      db
        .select()
        .from(schema.branchWriteJournal)
        .where(
          and(
            eq(schema.branchWriteJournal.threadId, THREAD_ID),
            eq(schema.branchWriteJournal.turnId, TURN_ID),
          ),
        ),
    noticeRows: () => db.select().from(schema.pendingNotices),
    async trailRowMembership() {
      return {
        shells: await db
          .select()
          .from(schema.changeTrailShells)
          .orderBy(schema.changeTrailShells.id),
        details: await db
          .select()
          .from(schema.changeTrailDocumentDetails)
          .orderBy(
            schema.changeTrailDocumentDetails.trailId,
            schema.changeTrailDocumentDetails.documentId,
          ),
        outbox: await db
          .select()
          .from(schema.changeTrailDeliveryOutbox)
          .orderBy(schema.changeTrailDeliveryOutbox.eventId),
      };
    },
    trailEventSequence: () =>
      db
        .select()
        .from(schema.changeTrailDeliveryOutbox)
        .orderBy(
          schema.changeTrailDeliveryOutbox.trailId,
          schema.changeTrailDeliveryOutbox.version,
          schema.changeTrailDeliveryOutbox.eventKind,
        ),
    threadPeerMarkdown: () => markdownByKind("thread_peer"),
    workDraftMarkdown: () => markdownByKind("work_draft"),
    async databaseBranchHashes() {
      return databaseBranchHashes();
    },
    async captureState() {
      return {
        databaseBranchHashes: await this.databaseBranchHashes(),
        threadPeerMarkdown: await this.threadPeerMarkdown(),
        workDraftMarkdown: await this.workDraftMarkdown(),
      };
    },
    async expectSuccessfulCommit(responseId: string) {
      expect(await this.responseJournalRows()).toHaveLength(2);
      expect(await databaseBranchHashes()).not.toEqual(preCommitBranchHashes);
      expect(await this.threadPeerMarkdown()).toEqual([
        expect.stringContaining("Agent alpha."),
        expect.stringContaining("Agent beta."),
      ]);
      expect(await this.workDraftMarkdown()).toEqual([
        expect.stringContaining("Agent alpha."),
        expect.stringContaining("Agent beta."),
      ]);
      expect(this.stagedUpdates(responseId)).toEqual([[], []]);
      expect(this.responseEvents(responseId)).toContainEqual({
        transition: "closed",
        phase: "closed",
      });
      expect(branchBroadcasts).toHaveLength(2);
      expect(watermarkCommits).toHaveLength(2);
      expect(this.openRoomIds()).toEqual([ALPHA_ID, BETA_ID]);
    },
  };

  async function databaseBranchHashes() {
    const rows = await db.select().from(schema.documentBranches);
    return rows
      .map((row) => ({
        id: row.id,
        state: Buffer.from(row.state).toString("base64"),
        stateVector: Buffer.from(row.stateVector).toString("base64"),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function serializeMarkdown(doc: Y.Doc): string {
  const blocks = model.getBlocks(toDocHandle(doc));
  return blocks.length === 0
    ? ""
    : markupCodec.serialize(model.projectBlocks(toDocHandle(doc)), UNSCOPED_DOCUMENT_LINKS);
}

export function replaceMarkdown(doc: Y.Doc, markdown: string): void {
  const parsed = markupCodec.parse(markdown);
  const replacement = documentSchema.node("doc", null, parsed.blocks);
  updateYFragment(doc, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), replacement, {
    mapping: new Map(),
    isOMark: new Map(),
  });
}

/** Counts push admissions inside the completion transaction for fault injection. */
function admissionProbe(
  effects: ReturnType<typeof createDrizzleDocumentProjectionEffects>,
  afterAdmission: ChangeTrailHarnessOptions["afterAdmission"],
): ReturnType<typeof createDrizzleDocumentProjectionEffects> {
  if (!afterAdmission) return effects;
  let ordinal = 0;
  return {
    ...effects,
    async applyPushCompletion(input) {
      await effects.applyPushCompletion(input);
      await afterAdmission({ documentId: input.documentId, ordinal: ++ordinal });
    },
  };
}

function fakeHocuspocus() {
  const documents = new Map<string, Y.Doc>();
  const broadcasts: string[] = [];
  return {
    documents,
    broadcasts,
    async openDirectConnection(documentName: string) {
      let document = documents.get(documentName);
      if (!document) {
        document = new Y.Doc({ gc: false });
        document.clientID = Number.parseInt(documentName.replaceAll("-", "").slice(-7), 16);
        document.on("update", () => broadcasts.push(documentName));
        documents.set(documentName, document);
      }
      return { document, disconnect: async () => undefined };
    },
  };
}
