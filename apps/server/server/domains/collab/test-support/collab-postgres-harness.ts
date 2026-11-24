/** Focused real-Postgres harness for collab durability tests. */

import type { WriteCommand } from "@meridian/agent-edit/integration";
import { createAgentEditCodecFactory, loroModel } from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  packCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { createAllowAllFileAccess } from "../../../domains/file-policy/index.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { closeTestDatabase } from "../../../test-support/drizzle-reset.js";
import { testFileGrant } from "../../../test-support/file-grants.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { insertWorks } from "../../../test-support/work-rows.js";
import { createDocumentLastAddress } from "../../context/document-uri-resolver.js";
import { createAgentEditHost } from "../adapters/agent-edit-host.js";
import { createDrizzleCollabLookups } from "../adapters/drizzle-collab-lookups.js";
import { createDrizzleDocumentCommands } from "../adapters/drizzle-document-commands.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../adapters/drizzle-drafts.js";
import { createDrizzleModelEdits } from "../adapters/drizzle-model-edits.js";
import { createDrizzleModelEvidence } from "../adapters/drizzle-model-evidence.js";
import { createDrizzleReversalLocks } from "../adapters/drizzle-reversal-locks.js";
import { createDrizzleTurnInverseService } from "../adapters/drizzle-turn-inverse.js";
import { createDrizzleWriteOrdinals } from "../adapters/drizzle-write-ordinals.js";
import {
  createStaticDocumentLinkScopes,
  UNSUPPORTED_AHEAD_REFS,
} from "../adapters/in-memory/static-document-link-scopes.js";
import type { RoutedWriteContext } from "../domain/agent-edit-cores.js";
import { createAgentEditRouter } from "../domain/agent-edit-router.js";
import { scopeModelEditWrite } from "../domain/document-link-scope-doors.js";
import { createDraftReviewIdentity } from "../domain/draft-review-identity.js";
import { createDrafts } from "../domain/drafts.js";
import { createModelDocumentEdits } from "../domain/model-document-edits.js";
import { createModelEditRead, createModelEditWriter } from "../domain/model-edit-write.js";
import type { DocumentLinkScopes } from "../domain/ports/document-link-scope.js";
import { createPostgresDocumentRooms } from "../rooms/postgres-document-rooms.js";
import { liveMarkdown, writeLiveMarkdown } from "./live-room-text.js";
import { modelWrite } from "./model-write.js";

const { createDb } = await import("@meridian/database");
export const schema = await import("@meridian/database/schema");
const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
  "@meridian/database/__test-support__/db-fixtures"
);
const { createDrizzleNoticePort } = await import("../../notices/index.js");
export const {
  currentDrizzleDb,
  isInDrizzleTransaction,
  deferUntilDrizzleRollback,
  runAfterDrizzleCommit,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
  runOutsideWrite,
} = await import("../../../shared/drizzle-transaction.js");
const { lockDocumentMutation } = await import("../../../shared/document-mutation-lock.js");
export const { DOCUMENT_RUNTIME_RESET_TABLES, deleteDrizzleRows } = await import(
  "../../../test-support/drizzle-reset.js"
);
const { createDrizzleWorkDraftPendingStore } = await import(
  "../adapters/drizzle-work-draft-pending.js"
);
const { createDraftReviewItems } = await import("../domain/draft-review-items.js");
const { createTreeReader } = await import("../../context/tree/tree-view.js");
const { draftFolderIds, createDrizzleDraftTreeState } = await import(
  "../adapters/drizzle-draft-tree-state.js"
);
const { createDrizzleDraftTreeActors } = await import("../adapters/drizzle-draft-tree-actors.js");
const { treeSeeder } = await import("../../../test-support/tree-seed.js");
const {
  createAgentEditObservabilityOptions,
  createDocumentProjectionDiagnostics,
  createReversalNoticeDiagnostics,
} = await import("../adapters/agent-edit-observability.js");
const { createAgentEditRuntime } = await import("../domain/agent-edit-runtime.js");
const { scopeAgentEdit } = await import("../domain/document-link-scope-doors.js");
const { createDocumentWriteHookRunner } = await import(
  "../domain/document-projection-refresher.js"
);
const { createReversalNoticePort } = await import("../domain/reversal-notices.js");
const { createTurnReversalService } = await import("../domain/turn-reversal-service.js");
const { UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS } = await import(
  "../adapters/declared-stubs.js"
);
const { createWorkDraftReviewService } = await import("../domain/work-draft-review-service.js");

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
const model = loroModel(documentSchema);

export const USER_ID = "00000000-0000-4000-8000-000000000801";
export const OTHER_USER_ID = "00000000-0000-4000-8000-000000000809";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
export const SOURCE_ID = "00000000-0000-4000-8000-000000000803";
export const WORK_ID = "00000000-0000-4000-8000-000000000804" as WorkId;
/** The draft the Work names. */
export const WORK_DRAFT_ID = "atomicitywk1";
export const ALPHA_ID = "00000000-0000-4000-8000-000000000805" as DocumentId;
export const BETA_ID = "00000000-0000-4000-8000-000000000806" as DocumentId;
export const GAMMA_ID = "00000000-0000-4000-8000-000000000810" as DocumentId;
export const THREAD_ID = "00000000-0000-4000-8000-000000000807" as ThreadId;
export const TURN_ID = "00000000-0000-4000-8000-000000000808" as TurnId;

export const DEFAULT_SCENARIO_IDS = {
  PROJECT_ID,
  SOURCE_ID,
  WORK_ID,
  WORK_DRAFT_ID,
  ALPHA_ID,
  BETA_ID,
  GAMMA_ID,
  THREAD_ID,
  TURN_ID,
};
export type CollabScenarioIds = typeof DEFAULT_SCENARIO_IDS;

export async function resetDatabase(db: Database): Promise<void> {
  // Clear the graph in this runner-owned disposable database using FK-ordered deletes.
  await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
  await seedDatabase(db);
}

/** Independent rows let warm and cold runs coexist without wiping durable evidence. */
export async function seedDatabase(
  db: Database,
  ids: CollabScenarioIds = DEFAULT_SCENARIO_IDS,
): Promise<void> {
  const {
    PROJECT_ID,
    SOURCE_ID,
    WORK_ID,
    WORK_DRAFT_ID,
    ALPHA_ID,
    BETA_ID,
    GAMMA_ID,
    THREAD_ID,
    TURN_ID,
  } = ids;
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
  await insertWorks(db, {
    id: WORK_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    name: "Atomicity work",
    handle: "w1",
    draftId: WORK_DRAFT_ID,
  });
  await db.insert(schema.contextSources).values({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    slug: "manuscript",
    scope: "project",
  });
  const seed = treeSeeder(db);
  await seed.document(SOURCE_ID, "alpha", { id: ALPHA_ID });
  await seed.document(SOURCE_ID, "beta", { id: BETA_ID });
  await seed.document(SOURCE_ID, "third.md", { id: GAMMA_ID });
  await db.insert(schema.threads).values({
    rootThreadId: THREAD_ID,
    id: THREAD_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Thread",
    kind: "primary",
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
  await closeTestDatabase(db);
}

export type CollabHarnessOptions = {
  ids?: CollabScenarioIds;
  /** Default: every grant is confirmed. */
  fileAccess?: import("../../file-policy/index.js").FileAccess;
  /** Default: a static scope, whose tokens ignore the tree. */
  links?: DocumentLinkScopes;
};

export function createHarness(db: Database, options: CollabHarnessOptions = {}) {
  // One link scope for every door the harness assembles, as composition shares one.
  const links = options.links ?? createStaticDocumentLinkScopes();
  const { ALPHA_ID, GAMMA_ID, THREAD_ID, TURN_ID } = options.ids ?? DEFAULT_SCENARIO_IDS;
  const documentName = (documentId: DocumentId) =>
    documentId === ALPHA_ID ? "alpha" : documentId === GAMMA_ID ? "third" : "beta";
  const ordinals = createDrizzleWriteOrdinals(db);
  const workDrafts = createDrafts({
    store: createDrizzleDraftStore(db),
    boundary: createDrizzleDraftWriteBoundary(db, createTestWorkProjectionMutation(db)),
  });
  const { treeLists, removals } = createTestRemovalDeps(db);
  const notices = createDrizzleNoticePort(db);
  const durableWorkDraftPendingStore = createDrizzleWorkDraftPendingStore(db);
  const events: Array<{
    name: string;
    level: string;
    payload: Record<string, unknown>;
    correlation?: object;
  }> = [];
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
  const resolveDocumentUri = async (documentId: string) =>
    `manuscript/${documentName(documentId as DocumentId)}.md`;
  const documentLastAddress = createDocumentLastAddress(db);
  const resolveLastDocumentUri = async (documentId: string, draftId?: DraftId) =>
    (await documentLastAddress(documentId as DocumentId, draftId))?.uri ?? null;
  const projectionDiagnostics = createDocumentProjectionDiagnostics(eventSink);
  const runDocumentWriteHook = createDocumentWriteHookRunner({
    hook: async () => {},
    diagnostics: projectionDiagnostics,
  });
  const observability = createAgentEditObservabilityOptions({ eventSink });
  const rooms = createPostgresDocumentRooms({
    db,
    shape: shapeSchemaOf(buildDocumentSchema()),
    eventSink,
    schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
  });
  const loroHost = createAgentEditHost({ db, rooms });
  const runtime = createAgentEditRuntime({
    loro: {
      rooms: loroHost.rooms,
      ordinals,
      documentEdits: createModelDocumentEdits({ service: () => turnInverse }),
      authorOfTurn: loroHost.authorOfTurn,
    },
    links,
    aheadRefs: UNSUPPORTED_AHEAD_REFS,
    lockDocument: (documentId) => lockDocumentMutation(currentDrizzleDb(db), documentId),
    rooms,
    transaction: (work) =>
      isInDrizzleTransaction()
        ? work(currentDrizzleDb(db))
        : runInDrizzleTransaction(db, () => work(currentDrizzleDb(db))),
    runDocumentWriteHook,
    resolveDocumentFiletype: async () => null,
    observability,
    inTransaction: isInDrizzleTransaction,
  });
  const projections = { refresh: runDocumentWriteHook };
  // Scoped as composition scopes it, so a real link scope sees every model call.
  const agentEditRouter = createAgentEditRouter({ core: runtime.core });
  const agentEdit = scopeAgentEdit(agentEditRouter, links);
  const modelEditRead = createModelEditRead(agentEdit.read);
  const modelEvidence = createDrizzleModelEvidence(db);
  const modelEdits = createDrizzleModelEdits(
    db,
    {
      write: scopeModelEditWrite(
        createModelEditWriter({
          core: runtime.core,
          fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
          enterSeam: async (documentId) => {
            await lockSeamWorks(db, []);
            await lockDocumentMutation(currentDrizzleDb(db), documentId);
          },
        }),
        links,
      ),
      read: modelEditRead,
    },
    modelEvidence,
  );
  const turnInverse = createDrizzleTurnInverseService({
    db,
    ordinals,
    rooms,
    resolveDocumentUri,
    resolveLastDocumentUri,
    refreshDocument: (documentId) => projections.refresh({ documentId }),
    notices: createReversalNoticePort({
      notices,
      resolveLastDocumentUri,
      diagnostics: createReversalNoticeDiagnostics(eventSink),
    }),
    workProjection: createTestWorkProjectionMutation(db),
    removals,
    fileAccess: options.fileAccess ?? createAllowAllFileAccess(),
    treeLists,
  });
  const turnReversal = createTurnReversalService({
    ...UNSUPPORTED_THREAD_CONTEXT_REVERSAL_COMMAND_DEPS,
    turnInverse,
    lockOwners: createDrizzleReversalLocks(db),
    resolveDocumentUri,
    commands: createDrizzleDocumentCommands(db),
  });
  const reviewItems = createDraftReviewItems({
    tree: createDrizzleDraftTreeState(db, createTreeReader(db)),
    text: (draftId, documentIds) =>
      durableWorkDraftPendingStore.listDraftTextChanges(draftId, documentIds),
    treeActors: createDrizzleDraftTreeActors(db, treeLists),
  });
  const lookups = createDrizzleCollabLookups(db);
  const identity = createDraftReviewIdentity({ drafts: workDrafts, reviewItems });
  const drafts = createWorkDraftReviewService({
    purgeDiscards: async () => 0,
    reviewItems,
    folderIds: (draftId) => draftFolderIds(db, draftId),
    // No tree lists in this fixture: a list read without a cut.
    treeCut: async () => ({}),
    pending: durableWorkDraftPendingStore,
    identity,
    commands: createDrizzleDocumentCommands(db),
    resolveThreadTitles: lookups.resolveThreadTitles,
  });
  // Tests mint a destination grant without a target; a write's grant names its document. A
  // write is the model's tool call as the chat loop sends it: one command, one transaction.
  const testAgentEdit = {
    ...agentEdit,
    write: (command: WriteCommand, context: RoutedWriteContext) => {
      const target = "documentId" in command ? command.documentId : undefined;
      return modelWrite(
        modelEdits,
        command,
        target
          ? {
              ...context,
              grant: {
                ...context.grant,
                facts: { ...context.grant.facts, target: { kind: "document", documentId: target } },
              },
            }
          : context,
        { accountId: USER_ID, projectId: PROJECT_ID },
      );
    },
  };
  const collab = {
    agentEdit: () => testAgentEdit,
    reverseTurn: turnReversal.reverseTurn,
    reversalOwners: turnInverse.reversalOwners,
    getDocumentAndTreeChip: turnInverse.getDocumentAndTreeChip,
    writeDocument: runtime.markdownDocuments.writeDocument,
    mergeCodeText: runtime.markdownDocuments.mergeCodeText,
    bindMarkdown: runtime.linkBinder.bindMarkdown,
    ...drafts,
  };

  async function seedWriterDocument(markdown: string, responseId: string): Promise<void> {
    await writeLiveMarkdown(rooms, ALPHA_ID, markdown);
    await collab.agentEdit().read(
      { file: "alpha.md", documentId: ALPHA_ID },
      {
        grant: testFileGrant({ kind: "live" }, ALPHA_ID),
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseIdentity: { modelResponseId: responseId },
      },
    );
  }

  return {
    seedWriterDocument,
    crossWorkProbeFixture: () => ({
      runtime,
      links,
      db,
      schema,
      collab,
      rooms,
      model,
      markupCodec,
      agentEditCodec,
    }),
    /** Stop producers and join their work before test reset or pool shutdown. */
    async dispose() {
      await rooms.close();
    },
    liveMarkdown: (documentId: DocumentId) => liveMarkdown(rooms, documentId),
  };
}
