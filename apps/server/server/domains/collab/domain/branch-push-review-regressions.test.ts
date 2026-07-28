/** Regression coverage for branch-push behavior preserved by the candidate pipeline. */

import {
  type DocumentCoordinator,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import {
  createInMemoryPendingSettlementStore,
  type InMemoryPendingSettlementStore,
} from "../test-support/in-memory-pending-settlement-store.js";
import type { BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import { createBranchPushService } from "./branch-push.js";
import type {
  BranchJournalReadStore,
  BranchJournalRow,
  PreparedDiscardCommit,
  PreparedPushCommit,
  PushCommitStore,
  PushLineageRow,
  WorkPushPolicyStore,
} from "./branch-push-contracts.js";
import { BranchPeerIntegrationError } from "./branch-push-plan.js";

const CONTENT_ID = "00000000-0000-4000-8000-000000000101" as DocumentId;
const MANIFEST_ID = "00000000-0000-4000-8000-000000000102" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000103" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000104" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000105" as TurnId;

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

function docFromMarkdown(markdown: string): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(doc), null, codec.parse(markdown));
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function branchFromDoc(branchId: string, documentId: DocumentId, doc: Y.Doc): BranchSnapshot {
  return {
    branchId,
    documentId,
    kind: "work_draft",
    upstreamBranchId: null,
    workId: WORK_ID,
    threadId: null,
    pushPolicy: "manual",
    status: "active",
    generation: 1,
    state: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
    schemaVersion: COLLAB_SCHEMA_VERSION,
  };
}

function rowFor(
  branch: BranchSnapshot,
  id: number,
  updateData: Uint8Array,
  updateMeta?: unknown,
): BranchJournalRow {
  return {
    id,
    branchId: branch.branchId,
    generation: branch.generation,
    wId: id,
    source: "agent",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    actorUserId: null,
    updateData,
    draftBaseUpdateSeq: 1,
    status: "active",
    ...(updateMeta === undefined ? {} : { updateMeta }),
  };
}

class StateBackedPushStores implements BranchJournalReadStore, PushCommitStore {
  readonly pushes: PushLineageRow[];

  constructor(
    readonly rows: BranchJournalRow[],
    pushes: readonly PushLineageRow[],
    private readonly journal: ReturnType<typeof createInMemoryJournal>,
    private readonly settlements: InMemoryPendingSettlementStore,
  ) {
    this.pushes = [...pushes];
  }

  async listActiveJournalRows(branchId: string, generation: number) {
    return this.rows.filter(
      (row) =>
        row.branchId === branchId && row.generation === generation && row.status === "active",
    );
  }

  async listReviewableJournalRows(branchId: string, generation: number) {
    return this.rows.filter(
      (row) =>
        row.branchId === branchId &&
        row.generation === generation &&
        (row.status === "active" || row.status === "rollback_pending"),
    );
  }

  async listConcurrentJournalRows(
    branchId: string,
    generation: number,
    options: { afterJournalId?: number; documentId: DocumentId },
  ) {
    return this.rows.filter(
      (row) =>
        row.branchId !== branchId &&
        row.generation <= generation &&
        row.status === "pushed" &&
        row.id > (options.afterJournalId ?? 0) &&
        this.pushes.some(
          (push) => push.branchId === row.branchId && push.documentId === options.documentId,
        ),
    );
  }

  async latestPushForBranch(branchId: string, generation: number) {
    return (
      [...this.pushes]
        .reverse()
        .find((push) => push.branchId === branchId && push.branchGeneration === generation) ?? null
    );
  }

  async listJournalRowsForTurn(input: {
    branchId?: string;
    generation?: number;
    threadId: ThreadId;
    turnId: TurnId;
    statuses?: readonly BranchJournalRow["status"][];
  }) {
    return this.rows.filter(
      (row) =>
        row.threadId === input.threadId &&
        row.turnId === input.turnId &&
        (input.branchId === undefined || row.branchId === input.branchId) &&
        (input.generation === undefined || row.generation === input.generation) &&
        (!input.statuses || input.statuses.includes(row.status)),
    );
  }

  async listJournalRowsForBranch(input: {
    branchId: string;
    generation: number;
    throughJournalId?: number;
  }) {
    return this.rows.filter(
      (row) =>
        row.branchId === input.branchId &&
        row.generation === input.generation &&
        (input.throughJournalId === undefined || row.id <= input.throughJournalId),
    );
  }

  async listPushLineageForTurn(input: { threadId: ThreadId; turnId: TurnId }) {
    return this.pushes.filter(
      (push) => push.threadId === input.threadId && push.turnId === input.turnId,
    );
  }

  async commitPush(input: PreparedPushCommit) {
    const existing = this.pushes.find((push) => push.idempotencyKey === input.idempotencyKey);
    if (existing) return { status: "conflict" as const, push: existing };
    const push = await this.insertPush(input);
    return { status: "inserted" as const, push };
  }

  async commitPushBatch(input: { pushes: PreparedPushCommit[] }) {
    const pushes: PushLineageRow[] = [];
    for (const prepared of input.pushes) pushes.push(await this.insertPush(prepared));
    return { pushes };
  }

  async commitDiscard(_input: PreparedDiscardCommit): Promise<void> {
    throw new Error("review regression store does not support discard");
  }

  async commitTurnRedo(_input: PreparedDiscardCommit): Promise<void> {
    throw new Error("review regression store does not support redo");
  }

  async markRollbackPending(): Promise<number> {
    throw new Error("review regression store does not support rollback marking");
  }

  private async insertPush(input: PreparedPushCommit): Promise<PushLineageRow> {
    const upstreamUpdateSeq = await this.journal.append(input.branch.documentId, input.pushUpdate, {
      origin: `push:${input.branch.branchId}`,
      seq: 0,
    });
    for (const candidate of input.journalRows) candidate.status = "pushed";
    const push: PushLineageRow = {
      id: this.pushes.length + 1,
      branchId: input.branch.branchId,
      branchGeneration: input.branch.generation,
      documentId: input.branch.documentId,
      journalIds: input.journalRows.map((row) => row.id),
      upstreamUpdateSeq,
      idempotencyKey: input.idempotencyKey,
      receiptId: input.receiptId,
      threadId: input.journalRows[0]?.threadId ?? null,
      turnId: input.journalRows[0]?.turnId ?? null,
    };
    this.pushes.push(push);
    this.settlements.stage({ ...input.pendingLiveSettlement, push });
    return push;
  }
}

function unsupportedWorkPolicyStore(): WorkPushPolicyStore {
  return {
    async updateWorkDraftPushPolicy() {
      throw new Error("review regression store does not support work policy writes");
    },
  };
}

function serviceFixture(input: {
  branches: readonly BranchSnapshot[];
  rows: BranchJournalRow[];
  pushes?: readonly PushLineageRow[];
  journal: ReturnType<typeof createInMemoryJournal>;
  liveDocs: ReadonlyMap<DocumentId, Y.Doc>;
}) {
  const settlements = createInMemoryPendingSettlementStore();
  const stores = new StateBackedPushStores(
    input.rows,
    input.pushes ?? [],
    input.journal,
    settlements,
  );
  const branches = new Map(input.branches.map((branch) => [branch.branchId, branch]));
  const branchStore: BranchStore = {
    deferUntilCommit(callback) {
      callback();
      return true;
    },
    async getBranch(branchId) {
      return branches.get(branchId) ?? null;
    },
    async updateBranchSnapshot() {
      return true;
    },
  };
  const liveCoordinator: DocumentCoordinator = {
    async withDocument(documentId, run) {
      const doc = input.liveDocs.get(documentId as DocumentId);
      if (!doc) throw new Error(`Missing live document ${documentId}`);
      return run(doc);
    },
    async recover() {},
  };
  return {
    stores,
    service: createBranchPushService({
      changeEventDelivery: { deliver() {} },
      branchStore,
      journalReadStore: stores,
      commitStore: stores,
      workPushPolicyStore: unsupportedWorkPolicyStore(),
      workDraftPendingStore: {
        async listReviewableEvidenceForWork() {
          throw new Error("review regression store does not support pending Work reads");
        },
      },
      settlementStore: settlements,
      journal: input.journal,
      liveCoordinator,
      model,
      codec,
    }),
  };
}

async function blindConflictFixture() {
  const contentLive = docFromMarkdown("Doomed paragraph.\n\nSurvivor paragraph.");
  const contentBranchDoc = cloneDoc(contentLive);
  const doomed = model.getBlocks(toDocHandle(contentBranchDoc))[0];
  if (!doomed) throw new Error("Missing branch block");
  const beforeDelete = Y.encodeStateVector(contentBranchDoc);
  model.deleteBlock(toDocHandle(contentBranchDoc), doomed);
  const contentBranch = branchFromDoc("branch_content", CONTENT_ID, contentBranchDoc);
  const row = rowFor(contentBranch, 1, Y.encodeStateAsUpdate(contentBranchDoc, beforeDelete));
  const journal = createInMemoryJournal();
  await journal.append(CONTENT_ID, Y.encodeStateAsUpdate(contentLive), {
    origin: "system",
    seq: 0,
  });
  const liveDoomed = model.getBlocks(toDocHandle(contentLive))[0];
  if (!liveDoomed) throw new Error("Missing live block");
  const beforeWriter = Y.encodeStateVector(contentLive);
  model.applyTextEdit(
    toDocHandle(contentLive),
    liveDoomed,
    { from: 0, to: model.getText(liveDoomed).length },
    "Writer changed this after the draft.",
  );
  await journal.append(CONTENT_ID, Y.encodeStateAsUpdate(contentLive, beforeWriter), {
    origin: "human:writer",
    seq: 0,
  });
  Y.applyUpdate(contentBranchDoc, Y.encodeStateAsUpdate(contentLive));
  contentBranch.state = Y.encodeStateAsUpdate(contentBranchDoc);
  contentBranch.stateVector = Y.encodeStateVector(contentBranchDoc);

  const manifestLive = docFromMarkdown("Manifest base.");
  const manifestBranch = branchFromDoc("branch_manifest", MANIFEST_ID, manifestLive);
  await journal.append(MANIFEST_ID, Y.encodeStateAsUpdate(manifestLive), {
    origin: "system",
    seq: 0,
  });
  const fixture = serviceFixture({
    branches: [contentBranch, manifestBranch],
    rows: [row],
    journal,
    liveDocs: new Map([
      [CONTENT_ID, contentLive],
      [MANIFEST_ID, manifestLive],
    ]),
  });
  return { ...fixture, contentBranch, manifestBranch };
}

describe("branch push review regressions", () => {
  it("rejects manifest membership rows with missing Yjs dependencies", async () => {
    const contentLive = docFromMarkdown("Content base.");
    const contentDoc = cloneDoc(contentLive);
    const beforeContent = Y.encodeStateVector(contentDoc);
    model.insertBlocks(toDocHandle(contentDoc), null, codec.parse("Draft content."));
    const contentBranch = branchFromDoc("branch_content", CONTENT_ID, contentDoc);
    const contentRow = rowFor(contentBranch, 1, Y.encodeStateAsUpdate(contentDoc, beforeContent));

    const manifestLive = createCollabYDoc({ gc: false });
    const manifestDoc = createCollabYDoc({ gc: false });
    const text = manifestDoc.getText("split-dependency");
    text.insert(0, "A");
    const beforeSecond = Y.encodeStateVector(manifestDoc);
    text.insert(1, "B");
    const manifestBranch = branchFromDoc("branch_manifest", MANIFEST_ID, manifestDoc);
    const manifestRow = rowFor(
      manifestBranch,
      2,
      Y.encodeStateAsUpdate(manifestDoc, beforeSecond),
      { kind: "manifest_membership", documentId: CONTENT_ID },
    );
    const journal = createInMemoryJournal();
    await journal.append(CONTENT_ID, Y.encodeStateAsUpdate(contentLive), {
      origin: "system",
      seq: 0,
    });
    await journal.append(MANIFEST_ID, Y.encodeStateAsUpdate(manifestLive), {
      origin: "system",
      seq: 0,
    });
    const { service } = serviceFixture({
      branches: [contentBranch, manifestBranch],
      rows: [contentRow, manifestRow],
      journal,
      liveDocs: new Map([
        [CONTENT_ID, contentLive],
        [MANIFEST_ID, manifestLive],
      ]),
    });

    const error = await service
      .pushToLiveWithManifestEntry({
        branchId: contentBranch.branchId,
        manifestBranchId: manifestBranch.branchId,
        manifestEntryDocumentId: CONTENT_ID,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BranchPeerIntegrationError);
    expect(error).toMatchObject({
      operation: "manifest_membership_push",
      journalIds: [2],
      message: "manifest_membership_push left pending Yjs dependencies for journal rows 2",
    });
  });

  it("always applies writer-overlapping whole and companion pushes", async () => {
    const whole = await blindConflictFixture();
    await expect(
      whole.service.pushToLive({
        branchId: whole.contentBranch.branchId,
      }),
    ).resolves.toMatchObject({ status: "pushed" });

    const companion = await blindConflictFixture();
    await expect(
      companion.service.pushToLiveWithManifestEntry({
        branchId: companion.contentBranch.branchId,
        manifestBranchId: companion.manifestBranch.branchId,
        manifestEntryDocumentId: CONTENT_ID,
      }),
    ).resolves.toMatchObject({ status: "pushed" });
  });
});
