/** Regression coverage for branch-push behavior preserved by the candidate pipeline. */

import {
  createAgentEditCodecFactory,
  type DocumentCoordinator,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import { createStaticDocumentLinkScopes } from "../adapters/in-memory/static-document-link-scopes.js";
import {
  createInMemoryPendingSettlementStore,
  type InMemoryPendingSettlementStore,
} from "../test-support/in-memory-pending-settlement-store.js";
import { MemoryDraftStore, memoryDraft, testDraftRow } from "../test-support/memory-draft-store.js";
import { createBranchPushService } from "./branch-push.js";
import type {
  BranchPushReadStore,
  PreparedDiscardCommit,
  PreparedPushCommit,
  PushCommitStore,
  PushLineageRow,
  SettlementBatchIdentity,
} from "./branch-push-contracts.js";
import type { DraftJournalRow } from "./draft-journal.js";
import type { DraftSnapshot, DraftStore } from "./draft-store.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

const CONTENT_ID = "00000000-0000-4000-8000-000000000101" as DocumentId;
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

/** A draft row and the content its checkpoint starts with. */
type SeededDraft = { documentDraft: DraftSnapshot; state: Uint8Array };

function draftFromDoc(draftId: string, documentId: DocumentId, doc: Y.Doc): SeededDraft {
  return {
    documentDraft: testDraftRow({ draftId, documentId, workId: WORK_ID }),
    state: Y.encodeStateAsUpdate(doc),
  };
}

function rowFor(
  documentDraft: DraftSnapshot,
  id: number,
  updateData: Uint8Array,
  updateMeta?: unknown,
): DraftJournalRow {
  return {
    id,
    draftId: documentDraft.draftId,
    generation: documentDraft.generation,
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

class StateBackedPushStores implements BranchPushReadStore, PushCommitStore {
  readonly pushes: PushLineageRow[];

  constructor(
    readonly rows: DraftJournalRow[],
    pushes: readonly PushLineageRow[],
    private readonly journal: ReturnType<typeof createInMemoryJournal>,
    private readonly settlements: InMemoryPendingSettlementStore,
  ) {
    this.pushes = [...pushes];
  }

  async listActiveJournalRows(draftId: string, generation: number) {
    return this.rows.filter(
      (row) => row.draftId === draftId && row.generation === generation && row.status === "active",
    );
  }

  async listReviewableJournalRows(draftId: string, generation: number) {
    return this.rows.filter(
      (row) =>
        row.draftId === draftId &&
        row.generation === generation &&
        (row.status === "active" || row.status === "rollback_pending"),
    );
  }

  async listConcurrentJournalRows(
    draftId: string,
    generation: number,
    options: { afterJournalId?: number; documentId: DocumentId },
  ) {
    return this.rows.filter(
      (row) =>
        row.draftId !== draftId &&
        row.generation <= generation &&
        row.status === "pushed" &&
        row.id > (options.afterJournalId ?? 0) &&
        this.pushes.some(
          (push) => push.draftId === row.draftId && push.documentId === options.documentId,
        ),
    );
  }

  async latestPushForDraft(draftId: string, generation: number) {
    return (
      [...this.pushes]
        .reverse()
        .find((push) => push.draftId === draftId && push.draftGeneration === generation) ?? null
    );
  }

  async listJournalRowsForTurn(input: {
    draftId?: string;
    generation?: number;
    threadId: ThreadId;
    turnId: TurnId;
    statuses?: readonly DraftJournalRow["status"][];
  }) {
    return this.rows.filter(
      (row) =>
        row.threadId === input.threadId &&
        row.turnId === input.turnId &&
        (input.draftId === undefined || row.draftId === input.draftId) &&
        (input.generation === undefined || row.generation === input.generation) &&
        (!input.statuses || input.statuses.includes(row.status)),
    );
  }

  async listJournalRowsForDraft(input: {
    draftId: string;
    generation: number;
    throughJournalId?: number;
  }) {
    return this.rows.filter(
      (row) =>
        row.draftId === input.draftId &&
        row.generation === input.generation &&
        (input.throughJournalId === undefined || row.id <= input.throughJournalId),
    );
  }

  async listPushLineageForTurn(input: { threadId: ThreadId; turnId: TurnId }) {
    return this.pushes.filter(
      (push) => push.threadId === input.threadId && push.turnId === input.turnId,
    );
  }

  async commitPushBatch(input: {
    settlement: SettlementBatchIdentity;
    pushes: readonly PreparedPushCommit[];
  }) {
    for (const prepared of input.pushes) {
      const existing = this.pushes.find((push) => push.idempotencyKey === prepared.idempotencyKey);
      if (existing) return { status: "conflict" as const, push: existing };
    }
    const pushes: PushLineageRow[] = [];
    for (const prepared of input.pushes) pushes.push(await this.insertPush(prepared));
    this.settlements.stage({
      batchId: input.settlement.batchId,
      claimToken: input.settlement.claimToken,
      members: input.pushes.map((prepared, index) => ({
        push: pushes[index] as PushLineageRow,
        documentTitle: prepared.documentTitle,
        lockCutUpdate: prepared.lockCutUpdate,
        pushUpdate: prepared.pushUpdate,
        trail: prepared.trail,
        sweepEvidence: null,
      })),
    });
    return { status: "inserted" as const, pushes };
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
    const upstreamUpdateSeq = await this.journal.append(
      input.documentDraft.documentId,
      input.pushUpdate,
      {
        origin: `push:${input.documentDraft.draftId}`,
        seq: 0,
      },
    );
    for (const candidate of input.journalRows) candidate.status = "pushed";
    const push: PushLineageRow = {
      id: this.pushes.length + 1,
      draftId: input.documentDraft.draftId,
      draftGeneration: input.documentDraft.generation,
      documentId: input.documentDraft.documentId,
      journalIds: input.journalRows.map((row) => row.id),
      upstreamUpdateSeq,
      idempotencyKey: input.idempotencyKey,
      receiptId: input.receiptId,
      threadId: input.journalRows[0]?.threadId ?? null,
      turnId: input.journalRows[0]?.turnId ?? null,
    };
    this.pushes.push(push);
    return push;
  }
}

function serviceFixture(input: {
  links?: DocumentLinkScopes;
  drafts: readonly SeededDraft[];
  rows: DraftJournalRow[];
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
  const draftStore: DraftStore = new MemoryDraftStore(
    input.drafts.map((seeded) => memoryDraft(seeded.documentDraft, seeded.state)),
  );
  const liveCoordinator: Pick<DocumentCoordinator, "withDocument" | "recover"> = {
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
      links: input.links ?? createStaticDocumentLinkScopes(),
      changeEventDelivery: { deliver() {} },
      draftStore,
      journalReadStore: stores,
      commitStore: stores,
      settlementStore: settlements,
      journal: input.journal,
      liveCoordinator,
      model,
      codec: createAgentEditCodecFactory(codec),
    }),
  };
}

async function blindConflictFixture(options: { links?: DocumentLinkScopes } = {}) {
  const contentLive = docFromMarkdown("Doomed paragraph.\n\nSurvivor paragraph.");
  const contentDraftDoc = cloneDoc(contentLive);
  const doomed = model.getBlocks(toDocHandle(contentDraftDoc))[0];
  if (!doomed) throw new Error("Missing draft block");
  const beforeDelete = Y.encodeStateVector(contentDraftDoc);
  model.deleteBlock(toDocHandle(contentDraftDoc), doomed);
  const contentDraft = draftFromDoc("draft_content", CONTENT_ID, contentDraftDoc);
  const row = rowFor(
    contentDraft.documentDraft,
    1,
    Y.encodeStateAsUpdate(contentDraftDoc, beforeDelete),
  );
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
  Y.applyUpdate(contentDraftDoc, Y.encodeStateAsUpdate(contentLive));
  contentDraft.state = Y.encodeStateAsUpdate(contentDraftDoc);

  const fixture = serviceFixture({
    ...options,
    drafts: [contentDraft],
    rows: [row],
    journal,
    liveDocs: new Map([[CONTENT_ID, contentLive]]),
  });
  return { ...fixture, contentDraft: contentDraft.documentDraft };
}

describe("branch push review regressions", () => {
  it("always applies writer-overlapping whole pushes", async () => {
    const whole = await blindConflictFixture();
    await expect(
      whole.service.pushToLive({
        draftId: whole.contentDraft.draftId,
      }),
    ).resolves.toMatchObject({ status: "pushed" });
  });
});
