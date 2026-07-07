/** Unit coverage for durable-first branch push lifecycle. */

import {
  applyConcurrentUpdates,
  createAgentEditCodec,
  type DocumentCoordinator,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import {
  createBranchAgentEditCoordinator,
  createBranchConcurrentJournalWatermarks,
  createBranchPendingJournalEntries,
} from "./branch-agent-edit.js";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import {
  type BranchJournalRow,
  BranchPeerIntegrationError,
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchPushStore,
  createBranchPushService,
  type PushLineageRow,
} from "./branch-push.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000002" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000004" as TurnId;
const USER_ID = "00000000-0000-4000-8000-000000000005" as UserId;

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);
const agentCodec = createAgentEditCodec(codec);

function docFromMarkdown(markdown: string): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  const parsed = codec.parse(markdown);
  model.insertBlocks(toDocHandle(doc), null, parsed);
  return doc;
}

function markdown(doc: Y.Doc): string {
  const blocks = model.getBlocks(toDocHandle(doc));
  return blocks.length === 0 ? "" : codec.serialize(model.projectBlocks(toDocHandle(doc)));
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, update);
  return doc;
}

function makeBranch(branchDoc: Y.Doc): BranchSnapshot {
  return {
    branchId: "branch_a",
    documentId: DOCUMENT_ID,
    kind: "work_draft",
    upstreamBranchId: null,
    workId: WORK_ID,
    threadId: null,
    pushPolicy: "manual",
    status: "active",
    generation: 1,
    state: Y.encodeStateAsUpdate(branchDoc),
    stateVector: Y.encodeStateVector(branchDoc),
    schemaVersion: 3,
  };
}

function listConcurrentJournalRowsInMemory(
  rows: readonly BranchJournalRow[],
  branchForRow: (branchId: string) => BranchSnapshot | null | undefined,
): BranchPushStore["listConcurrentJournalRows"] {
  return async (branchId, generation, options) =>
    rows.filter((row) => {
      if (row.id <= (options.afterJournalId ?? 0)) return false;
      const owner = branchForRow(row.branchId);
      if (!owner || owner.documentId !== options.documentId) return false;
      if (row.branchId === branchId) {
        return row.generation <= generation && (row.status === "active" || row.status === "pushed");
      }
      return row.generation <= owner.generation && row.status === "pushed";
    });
}

function appendParagraph(doc: Y.Doc, text: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const parsed = codec.parse(text);
  const blocks = model.getBlocks(toDocHandle(doc));
  model.insertBlocks(toDocHandle(doc), blocks.at(-1) ?? null, parsed);
  return Y.encodeStateAsUpdate(doc, before);
}

class Harness {
  readonly journal = createInMemoryJournal();
  readonly liveDoc = docFromMarkdown("Base.");
  readonly branchDoc = cloneDoc(this.liveDoc);
  readonly update = appendParagraph(this.branchDoc, "Draft words here.");
  readonly branch = makeBranch(this.branchDoc);
  readonly row: BranchJournalRow = {
    id: 1,
    branchId: this.branch.branchId,
    generation: this.branch.generation,
    wId: 1,
    source: "agent",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    actorUserId: null,
    updateData: this.update,
    status: "active",
  };
  readonly branchStore: BranchStore = {
    getBranch: vi.fn(async () => this.branch),
    updateBranchSnapshot: vi.fn(async () => true),
  };
  readonly branchCoordinator = {
    resetFromDocIfUnchanged: vi.fn(async (_input: { branchId: string; upstream: Y.Doc }) => {
      const upstream = _input.upstream;
      this.branch.generation += 1;
      this.branch.state = Y.encodeStateAsUpdate(upstream);
      this.branch.stateVector = Y.encodeStateVector(upstream);
      return true;
    }),
    broadcastUpdate: vi.fn(),
  };
  readonly lineage: PushLineageRow[] = [];
  policy: "manual" | "auto" = "manual";
  failApply = false;
  readonly pushStore: BranchPushStore = {
    listActiveJournalRows: vi.fn(async () => (this.row.status === "active" ? [this.row] : [])),
    listConcurrentJournalRows: vi.fn(
      listConcurrentJournalRowsInMemory([this.row], (branchId) =>
        branchId === this.branch.branchId ? this.branch : null,
      ),
    ),
    latestPushForBranch: vi.fn(async () => this.lineage.at(-1) ?? null),
    commitPush: vi.fn(async (input) => {
      const existing = this.lineage.find((row) => row.idempotencyKey === input.idempotencyKey);
      if (existing) return { status: "conflict" as const, push: existing };
      const seq = await this.journal.append(input.branch.documentId, input.pushUpdate, {
        origin: `push:${input.branch.branchId}`,
        seq: 0,
      });
      this.row.status = "pushed";
      const push: PushLineageRow = {
        id: this.lineage.length + 1,
        branchId: input.branch.branchId,
        documentId: input.branch.documentId,
        pushKind: "whole" as const,
        journalIds: input.journalRows.map((row: BranchJournalRow) => row.id),
        upstreamUpdateSeq: seq,
        receiptPayload: input.receiptPayload,
        idempotencyKey: input.idempotencyKey,
      };
      this.lineage.push(push);
      return { status: "inserted" as const, push };
    }),
    countUnpushedRowsForWork: vi.fn(async () => (this.row.status === "active" ? 1 : 0)),
    listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [this.branch.branchId]),
    updateWorkDraftPushPolicy: vi.fn(async (_workId, policy) => {
      this.policy = policy;
    }),
    markRollbackPending: vi.fn(async () => {
      this.row.status = "rollback_pending";
      return 1;
    }),
  };
  readonly coordinator: DocumentCoordinator = {
    withDocument: vi.fn(async (_docId, fn) => {
      if (this.failApply) throw new Error("apply failed after commit");
      return fn(this.liveDoc);
    }),
    recover: vi.fn(async () => {}),
  };

  async init(): Promise<void> {
    await this.journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(this.liveDoc), {
      origin: "system",
      seq: 0,
    });
  }

  service() {
    return createBranchPushService({
      branchStore: this.branchStore,
      pushStore: this.pushStore,
      branchCoordinator: this.branchCoordinator,
      journal: this.journal,
      liveCoordinator: this.coordinator,
      model,
      codec,
    });
  }
}

describe("createBranchPushService", () => {
  it("fails loudly when a selective push row is not causally closed", async () => {
    const harness = new Harness();
    await harness.init();
    const branchDoc = createCollabYDoc({ gc: false });
    const text = branchDoc.getText("split-dependency");
    const beforeFirst = Y.encodeStateVector(branchDoc);
    text.insert(0, "A");
    const firstUpdate = Y.encodeStateAsUpdate(branchDoc, beforeFirst);
    const beforeSecond = Y.encodeStateVector(branchDoc);
    text.insert(1, "B");
    const secondUpdate = Y.encodeStateAsUpdate(branchDoc, beforeSecond);
    harness.branch.state = Y.encodeStateAsUpdate(branchDoc);
    harness.branch.stateVector = Y.encodeStateVector(branchDoc);
    const rows: BranchJournalRow[] = [
      { ...harness.row, id: 1, updateData: firstUpdate },
      { ...harness.row, id: 2, wId: 2, updateData: secondUpdate },
    ];
    harness.pushStore.listActiveJournalRows = vi.fn(async () => rows);

    await expect(
      harness.service().pushSelectedToLive({ branchId: harness.branch.branchId, journalIds: [2] }),
    ).rejects.toBeInstanceOf(BranchPeerIntegrationError);
    expect(harness.pushStore.commitPush).not.toHaveBeenCalled();
  });

  it("discards selected rows by syncing an undo-built reversal peer", async () => {
    const harness = new Harness();
    await harness.init();
    let committedState: Uint8Array | null = null;
    harness.pushStore.commitDiscard = vi.fn(async (input) => {
      committedState = input.state;
      harness.row.status = "discarded";
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });

    const result = await harness.service().discardSelected({
      branchId: harness.branch.branchId,
      journalIds: [harness.row.id],
      reviewedByUserId: USER_ID,
    });

    expect(result).toEqual({
      status: "discarded",
      branchId: harness.branch.branchId,
      journalIds: [1],
    });
    expect(harness.pushStore.commitDiscard).toHaveBeenCalledOnce();
    expect(committedState).not.toBeNull();
    const after = docFromUpdate(committedState as unknown as Uint8Array);
    expect(markdown(after).trim()).toBe("Base.");
  });

  it("broadcasts the committed discard reversal to open branch rooms", async () => {
    const harness = new Harness();
    await harness.init();
    const roomDoc = cloneDoc(harness.branchDoc);
    harness.branchCoordinator.broadcastUpdate.mockImplementation(({ update }) => {
      Y.applyUpdate(roomDoc, update);
    });
    harness.pushStore.commitDiscard = vi.fn(async (input) => {
      harness.row.status = "discarded";
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });

    await harness.service().discardSelected({
      branchId: harness.branch.branchId,
      journalIds: [harness.row.id],
      reviewedByUserId: USER_ID,
    });

    expect(harness.branchCoordinator.broadcastUpdate).toHaveBeenCalledOnce();
    expect(markdown(roomDoc).trim()).toBe("Base.");
    roomDoc.destroy();
  });

  it("commits once for idempotent retry and returns the existing lineage row", async () => {
    const harness = new Harness();
    await harness.init();
    const service = harness.service();

    const first = await service.pushToLive({ branchId: harness.branch.branchId });
    const second = await service.pushToLive({ branchId: harness.branch.branchId });

    expect(first.status).toBe("pushed");
    expect(second.status).toBe("already_pushed");
    expect(harness.lineage).toHaveLength(1);
    expect(harness.lineage[0].receiptPayload?.changedBlocks).toHaveLength(1);
    expect(markdown(harness.liveDoc)).toContain("Draft words here.");
  });

  it("leaves durable journal recoverable when phase 3 apply fails after phase 2 commit", async () => {
    const harness = new Harness();
    await harness.init();
    harness.failApply = true;

    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).rejects.toThrow("apply failed");

    const recovered = createCollabYDoc({ gc: false });
    const snapshot = await harness.journal.read(DOCUMENT_ID);
    if (snapshot.checkpoint) Y.applyUpdate(recovered, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(recovered, row.update);
    expect(markdown(recovered)).toContain("Draft words here.");
    expect(markdown(harness.liveDoc)).not.toContain("Draft words here.");

    harness.failApply = false;
    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).resolves.toMatchObject({ status: "already_pushed", push: harness.lineage[0] });
    expect(harness.lineage).toHaveLength(1);
  });

  it("resets drained auto branches from live after a successful push", async () => {
    const harness = new Harness();
    await harness.init();
    harness.branch.pushPolicy = "auto";
    const beforeGeneration = harness.branch.generation;

    const result = await harness.service().pushToLive({ branchId: harness.branch.branchId });

    expect(result).toMatchObject({
      status: "pushed",
      branchReset: { branchId: harness.branch.branchId, fromGeneration: beforeGeneration },
    });
    expect(harness.branch.generation).toBe(beforeGeneration + 1);
    expect(markdown(docFromUpdate(harness.branch.state))).toBe(markdown(harness.liveDoc));
    expect([...harness.branch.state]).toEqual([...Y.encodeStateAsUpdate(harness.liveDoc)]);
  });

  it("leaves auto branches intact when a concurrent row remains after push", async () => {
    const harness = new Harness();
    await harness.init();
    harness.branch.pushPolicy = "auto";
    const concurrent = { ...harness.row, id: 2, status: "active" as const };
    harness.pushStore.listActiveJournalRows = vi
      .fn()
      .mockResolvedValueOnce([harness.row])
      .mockResolvedValueOnce([concurrent]);

    const result = await harness.service().pushToLive({ branchId: harness.branch.branchId });

    expect(result.status).toBe("pushed");
    expect(harness.branchCoordinator.resetFromDocIfUnchanged).not.toHaveBeenCalled();
    expect(harness.branch.generation).toBe(1);
  });

  it("exposes a typed GATE2 auto-push seam that only pushes auto work drafts", async () => {
    const harness = new Harness();
    await harness.init();
    const service = harness.service();

    await expect(
      service.pushAutoBranchAfterThreadPeerWrite({ workDraftBranchId: harness.branch.branchId }),
    ).resolves.toEqual({ status: "skipped", reason: "manual_policy" });

    harness.branch.pushPolicy = "auto";
    await expect(
      service.pushAutoBranchAfterThreadPeerWrite({ workDraftBranchId: harness.branch.branchId }),
    ).resolves.toMatchObject({ status: "pushed" });
  });

  it("requires confirmation before manual to auto, pushes before flipping, and resets drained branches", async () => {
    const harness = new Harness();
    await harness.init();
    const service = harness.service();
    const beforeGeneration = harness.branch.generation;

    await expect(
      service.setWorkPushPolicy({ workId: WORK_ID, policy: "auto" }),
    ).resolves.toMatchObject({ status: "confirmation_required", unpushedCount: 1 });
    expect(harness.policy).toBe("manual");

    await expect(
      service.setWorkPushPolicy({ workId: WORK_ID, policy: "auto", confirmedPush: true }),
    ).resolves.toEqual({ status: "updated", policy: "auto" });
    expect(harness.lineage).toHaveLength(1);
    expect(harness.branchCoordinator.resetFromDocIfUnchanged).toHaveBeenCalled();
    expect(harness.branch.generation).toBe(beforeGeneration + 1);
    expect(harness.policy).toBe("auto");
  });

  it("keeps manual policy and active rows when confirmed auto push fails", async () => {
    const harness = new Harness();
    await harness.init();
    harness.pushStore.commitPush = vi.fn(async () => {
      throw new Error("push failed");
    });

    await expect(
      harness.service().setWorkPushPolicy({ workId: WORK_ID, policy: "auto", confirmedPush: true }),
    ).rejects.toThrow("push failed");
    expect(harness.policy).toBe("manual");
    expect(harness.row.status).toBe("active");
  });

  it("bounds branch CAS push retries with a typed give-up error", async () => {
    const harness = new Harness();
    await harness.init();
    harness.pushStore.commitPush = vi.fn(async () => {
      throw new BranchPushCommitConflictError(harness.branch.branchId);
    });

    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).rejects.toBeInstanceOf(BranchPushRetryExhaustedError);
    expect(harness.pushStore.commitPush).toHaveBeenCalledTimes(4);
  });

  it("marks failed response rows rollback_pending through the typed S5 seam", async () => {
    const harness = new Harness();
    await harness.init();

    await expect(
      harness.service().markFailedResponseRollbackPending({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).resolves.toEqual({ status: "rollback_pending", rowsMarked: 1 });
    expect(harness.row.status).toBe("rollback_pending");
  });

  it("applies rollback-pending rows through the reviewable-row path", async () => {
    const harness = new Harness();
    await harness.init();
    harness.row.status = "rollback_pending";
    harness.pushStore.listReviewableJournalRows = vi.fn(async () => [harness.row]);

    const result = await harness.service().pushSelectedToLive({
      branchId: harness.branch.branchId,
      journalIds: [harness.row.id],
      pushedByUserId: USER_ID,
    });

    expect(result.status).toBe("pushed");
    expect(harness.row.status).toBe("pushed");
  });

  it("discards rollback-pending rows through the reviewable-row path", async () => {
    const harness = new Harness();
    await harness.init();
    harness.row.status = "rollback_pending";
    harness.pushStore.listReviewableJournalRows = vi.fn(async () => [harness.row]);
    harness.pushStore.commitDiscard = vi.fn(async (input) => {
      harness.row.status = "discarded";
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });

    await expect(
      harness.service().discardSelected({
        branchId: harness.branch.branchId,
        journalIds: [harness.row.id],
        reviewedByUserId: USER_ID,
      }),
    ).resolves.toEqual({
      status: "discarded",
      branchId: harness.branch.branchId,
      journalIds: [1],
    });
    expect(harness.row.status).toBe("discarded");
  });

  it("reverses and redoes a whole turn through the branch reversal peer", async () => {
    const harness = new Harness();
    await harness.init();
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) =>
      [harness.row].filter(
        (row) =>
          row.branchId === (input.branchId ?? row.branchId) &&
          row.threadId === input.threadId &&
          row.turnId === input.turnId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
    );
    harness.pushStore.commitDiscard = vi.fn(async (input) => {
      harness.row.status = "discarded";
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });
    harness.pushStore.commitTurnRedo = vi.fn(async (input) => {
      harness.row.status = "active";
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });
    const service = harness.service();

    await expect(
      service.reverseBranchTurn({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        reviewedByUserId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reversed", branchId: harness.branch.branchId, journalIds: [1] });
    expect(markdown(docFromUpdate(harness.branch.state)).trim()).toBe("Base.");

    await expect(
      service.reverseBranchTurn({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
        reviewedByUserId: USER_ID,
      }),
    ).resolves.toEqual({
      status: "reconciled",
      branchId: harness.branch.branchId,
      journalIds: [1],
    });
    expect(markdown(docFromUpdate(harness.branch.state))).toContain("Draft words here.");
  });

  it("degrades turn undo when a later row edits inside the selected paragraph", async () => {
    const harness = new Harness();
    await harness.init();
    const base = cloneDoc(harness.liveDoc);
    const firstDoc = cloneDoc(base);
    const firstUpdate = appendParagraph(firstDoc, "Agent paragraph.");
    const secondDoc = cloneDoc(firstDoc);
    const agentParagraph = model.getBlocks(toDocHandle(secondDoc)).at(-1);
    if (!agentParagraph) throw new Error("missing agent paragraph");
    model.applyTextEdit(toDocHandle(secondDoc), agentParagraph, { from: 6, to: 15 }, "writer edit");
    const secondUpdate = Y.encodeStateAsUpdate(secondDoc, Y.encodeStateVector(firstDoc));
    harness.branch.state = Y.encodeStateAsUpdate(secondDoc);
    harness.branch.stateVector = Y.encodeStateVector(secondDoc);
    const first: BranchJournalRow = { ...harness.row, id: 1, updateData: firstUpdate };
    const second: BranchJournalRow = {
      ...harness.row,
      id: 2,
      wId: 2,
      source: "writer",
      turnId: "00000000-0000-4000-8000-000000000024" as TurnId,
      updateData: secondUpdate,
    };
    const rows = [first, second];
    harness.pushStore.listActiveJournalRows = vi.fn(async () => rows);
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) =>
      rows.filter(
        (row) =>
          row.threadId === input.threadId &&
          row.turnId === input.turnId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
    );
    harness.pushStore.commitDiscard = vi.fn(async () => {
      throw new Error("must not discard dependent turn");
    });

    await expect(
      harness.service().reverseBranchTurn({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
      }),
    ).resolves.toEqual({
      status: "cant_undo_dependent",
      branchId: harness.branch.branchId,
      journalIds: [1],
    });
    expect(markdown(docFromUpdate(harness.branch.state))).toContain("Agent writer edit.");
    base.destroy();
    firstDoc.destroy();
    secondDoc.destroy();
  });

  it("keeps an earlier turn undoable when a later active row touches independent content", async () => {
    const harness = new Harness();
    await harness.init();
    const base = cloneDoc(harness.liveDoc);
    const firstDoc = cloneDoc(base);
    const firstBlock = model.getBlocks(toDocHandle(firstDoc))[0];
    if (!firstBlock) throw new Error("missing first block");
    model.applyTextEdit(toDocHandle(firstDoc), firstBlock, { from: 0, to: 4 }, "Seed");
    const firstUpdate = Y.encodeStateAsUpdate(firstDoc, Y.encodeStateVector(base));
    const secondDoc = cloneDoc(firstDoc);
    const secondUpdate = appendParagraph(secondDoc, "Independent later paragraph.");
    harness.branch.state = Y.encodeStateAsUpdate(secondDoc);
    harness.branch.stateVector = Y.encodeStateVector(secondDoc);
    const first: BranchJournalRow = {
      ...harness.row,
      id: 1,
      updateData: firstUpdate,
      status: "active",
    };
    const second: BranchJournalRow = {
      ...harness.row,
      id: 2,
      wId: 2,
      turnId: "00000000-0000-4000-8000-000000000024" as TurnId,
      updateData: secondUpdate,
      status: "active" as const,
    };
    const rows = [first, second];
    harness.pushStore.listActiveJournalRows = vi.fn(async () =>
      rows.filter((row) => row.status === "active"),
    );
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) =>
      rows.filter(
        (row) =>
          row.branchId === (input.branchId ?? row.branchId) &&
          (input.generation === undefined || row.generation === input.generation) &&
          row.threadId === input.threadId &&
          row.turnId === input.turnId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
    );
    harness.pushStore.commitDiscard = vi.fn(async (input) => {
      first.status = "discarded";
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });

    await expect(
      harness.service().reverseBranchTurn({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
      }),
    ).resolves.toEqual({ status: "reversed", branchId: harness.branch.branchId, journalIds: [1] });
    const after = markdown(docFromUpdate(harness.branch.state));
    expect(after).toContain("Base.");
    expect(after).toContain("Independent later paragraph.");
    firstDoc.destroy();
    secondDoc.destroy();
    base.destroy();
  });

  it("keeps redo replacement bytes per row for later selective apply", async () => {
    const harness = new Harness();
    harness.liveDoc.destroy();
    const liveDoc = docFromMarkdown("Alpha target.\n\nBeta target.");
    Object.assign(harness, { liveDoc });
    await harness.init();
    const firstDoc = cloneDoc(harness.liveDoc);
    const firstBlock = model.getBlocks(toDocHandle(firstDoc))[0];
    if (!firstBlock) throw new Error("missing first block");
    model.applyTextEdit(toDocHandle(firstDoc), firstBlock, { from: 0, to: 5 }, "Alpha redone");
    const firstUpdate = Y.encodeStateAsUpdate(firstDoc, Y.encodeStateVector(harness.liveDoc));
    const secondDoc = cloneDoc(firstDoc);
    const secondBlock = model.getBlocks(toDocHandle(secondDoc))[1];
    if (!secondBlock) throw new Error("missing second block");
    model.applyTextEdit(toDocHandle(secondDoc), secondBlock, { from: 0, to: 4 }, "Beta redone");
    const secondUpdate = Y.encodeStateAsUpdate(secondDoc, Y.encodeStateVector(firstDoc));
    const rowA: BranchJournalRow = {
      ...harness.row,
      id: 1,
      updateData: firstUpdate,
      status: "discarded",
    };
    const rowB: BranchJournalRow = {
      ...harness.row,
      id: 2,
      wId: 2,
      updateData: secondUpdate,
      status: "discarded",
    };
    const rows = [rowA, rowB];
    harness.branch.state = Y.encodeStateAsUpdate(harness.liveDoc);
    harness.branch.stateVector = Y.encodeStateVector(harness.liveDoc);
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) =>
      rows.filter(
        (row) =>
          row.threadId === input.threadId &&
          row.turnId === input.turnId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
    );
    harness.pushStore.listJournalRowsForBranch = vi.fn(async () => rows);
    harness.pushStore.listActiveJournalRows = vi.fn(async () =>
      rows.filter((row) => row.status === "active"),
    );
    harness.pushStore.commitTurnRedo = vi.fn(async (input) => {
      for (const row of input.journalRows) {
        row.status = "active";
        row.updateData = input.replacementUpdateDataByJournalId?.get(row.id) ?? row.updateData;
      }
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });

    await expect(
      harness.service().reverseBranchTurn({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
      }),
    ).resolves.toEqual({
      status: "reconciled",
      branchId: harness.branch.branchId,
      journalIds: [1, 2],
    });

    await harness.service().pushSelectedToLive({
      branchId: harness.branch.branchId,
      journalIds: [rowA.id],
    });
    const live = markdown(harness.liveDoc);
    expect(live).toContain("Alpha redone target.");
    expect(live).not.toContain("Beta redone target.");
    firstDoc.destroy();
    secondDoc.destroy();
  });

  it("fences branch redo to the current generation after a reset", async () => {
    const harness = new Harness();
    await harness.init();
    harness.row.status = "discarded";
    harness.branch.generation += 1;
    harness.branch.state = Y.encodeStateAsUpdate(harness.liveDoc);
    harness.branch.stateVector = Y.encodeStateVector(harness.liveDoc);
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) =>
      [harness.row].filter(
        (row) =>
          row.branchId === (input.branchId ?? row.branchId) &&
          (input.generation === undefined || row.generation === input.generation) &&
          row.threadId === input.threadId &&
          row.turnId === input.turnId &&
          (!input.statuses || input.statuses.includes(row.status)),
      ),
    );
    harness.pushStore.commitTurnRedo = vi.fn(async () => {
      throw new Error("must not redo an old generation row");
    });

    await expect(
      harness.service().reverseBranchTurn({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
      }),
    ).resolves.toEqual({
      status: "nothing_to_redo",
      branchId: harness.branch.branchId,
      journalIds: [],
    });
    expect(markdown(docFromUpdate(harness.branch.state)).trim()).toBe("Base.");
  });

  it("flags a conflict echo with origin metadata after overlapping branch pushes", async () => {
    const liveDoc = docFromMarkdown("Shared line.");
    const branchADoc = cloneDoc(liveDoc);
    const branchBDoc = cloneDoc(liveDoc);
    model.applyTextEdit(
      toDocHandle(branchADoc),
      model.getBlocks(toDocHandle(branchADoc))[0],
      { from: 0, to: 6 },
      "Alpha",
    );
    model.applyTextEdit(
      toDocHandle(branchBDoc),
      model.getBlocks(toDocHandle(branchBDoc))[0],
      { from: 0, to: 6 },
      "Beta",
    );
    const branchA = { ...makeBranch(branchADoc), branchId: "branch_a" };
    const branchB = { ...makeBranch(branchBDoc), branchId: "branch_b" };
    const rows: BranchJournalRow[] = [
      {
        id: 1,
        branchId: branchA.branchId,
        generation: branchA.generation,
        wId: 11,
        source: "agent",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actorUserId: null,
        updateData: Y.encodeStateAsUpdate(branchADoc),
        status: "active",
      },
      {
        id: 2,
        branchId: branchB.branchId,
        generation: branchB.generation,
        wId: 22,
        source: "agent",
        threadId: THREAD_ID,
        turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
        actorUserId: null,
        updateData: Y.encodeStateAsUpdate(branchBDoc),
        status: "active",
      },
    ];
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), { origin: "system", seq: 0 });
    const lineage: PushLineageRow[] = [];
    const service = createBranchPushService({
      branchStore: {
        getBranch: vi.fn(async (branchId: string) =>
          branchId === branchA.branchId ? branchA : branchId === branchB.branchId ? branchB : null,
        ),
        updateBranchSnapshot: vi.fn(async () => true),
      },
      pushStore: {
        listActiveJournalRows: vi.fn(async (branchId, generation) =>
          rows.filter(
            (row) =>
              row.branchId === branchId && row.generation === generation && row.status === "active",
          ),
        ),
        listConcurrentJournalRows: vi.fn(
          listConcurrentJournalRowsInMemory(rows, (branchId) =>
            branchId === branchA.branchId
              ? branchA
              : branchId === branchB.branchId
                ? branchB
                : null,
          ),
        ),
        latestPushForBranch: vi.fn(
          async (branchId) => lineage.find((row) => row.branchId === branchId) ?? null,
        ),
        listPushesForDocument: vi.fn(async () => lineage),
        commitPush: vi.fn(async (input) => {
          const seq = await journal.append(input.branch.documentId, input.pushUpdate, {
            origin: `push:${input.branch.branchId}`,
            seq: 0,
          });
          for (const row of input.journalRows) row.status = "pushed";
          const push: PushLineageRow = {
            id: lineage.length + 1,
            branchId: input.branch.branchId,
            documentId: input.branch.documentId,
            pushKind: "whole" as const,
            journalIds: input.journalRows.map((row: BranchJournalRow) => row.id),
            upstreamUpdateSeq: seq,
            receiptPayload: input.receiptPayload,
            idempotencyKey: input.idempotencyKey,
            threadId: input.journalRows[0]?.threadId ?? null,
            turnId: input.journalRows[0]?.turnId ?? null,
          };
          lineage.push(push);
          return { status: "inserted" as const, push };
        }),
        countUnpushedRowsForWork: vi.fn(async () => 0),
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => []),
        updateWorkDraftPushPolicy: vi.fn(async () => undefined),
        markRollbackPending: vi.fn(async () => 0),
      },
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (_id, fn) => fn(liveDoc)),
        recover: vi.fn(async () => {}),
      },
      model,
      codec,
    });

    const first = await service.pushToLive({ branchId: branchA.branchId });
    const second = await service.pushToLive({ branchId: branchB.branchId });

    expect(first.status).toBe("pushed");
    expect(second.status).toBe("pushed");
    expect(lineage).toHaveLength(2);
    expect(markdown(liveDoc)).toContain("Alpha");
    expect(markdown(liveDoc)).toContain("Beta");
    expect(second.status === "pushed" ? second.conflictEcho : undefined).toEqual(
      expect.objectContaining({
        current: [expect.objectContaining({ id: 2, wId: 22, threadId: THREAD_ID })],
        concurrentPushes: [
          expect.objectContaining({ id: 1, journalIds: [1], threadId: THREAD_ID }),
        ],
      }),
    );
  });

  it("does not echo pre-reset pushes already incorporated into the branch base", async () => {
    const liveDoc = docFromMarkdown("Alpha line.");
    const branchDoc = cloneDoc(liveDoc);
    model.applyTextEdit(
      toDocHandle(branchDoc),
      model.getBlocks(toDocHandle(branchDoc))[0],
      { from: 0, to: 5 },
      "Beta",
    );
    const branch = { ...makeBranch(branchDoc), branchId: "branch_after_reset", generation: 2 };
    const row: BranchJournalRow = {
      id: 2,
      branchId: branch.branchId,
      generation: branch.generation,
      wId: 22,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(branchDoc),
      status: "active",
    };
    const priorReceipt = {
      version: 1 as const,
      documentId: DOCUMENT_ID,
      branchId: "branch_before_reset",
      branchGeneration: 1,
      pushKind: "whole" as const,
      changedBlocks: [
        {
          blockId: model.getDocumentBlockIds(toDocHandle(liveDoc))[0] ?? "missing",
          beforeText: "Shared line.",
          afterText: "Alpha line.",
          beforeWordCount: 2,
          afterWordCount: 2,
          wordDelta: 0,
        },
      ],
      totalWordDelta: 0,
    };
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), { origin: "system", seq: 0 });
    const service = createBranchPushService({
      branchStore: {
        getBranch: vi.fn(async (branchId: string) =>
          branchId === branch.branchId ? branch : null,
        ),
        updateBranchSnapshot: vi.fn(async () => true),
      },
      pushStore: {
        listActiveJournalRows: vi.fn(async () => [row]),
        listConcurrentJournalRows: vi.fn(
          listConcurrentJournalRowsInMemory([row], (branchId) =>
            branchId === branch.branchId ? branch : null,
          ),
        ),
        latestPushForBranch: vi.fn(async () => null),
        listPushesForDocument: vi.fn(async () => [
          {
            id: 1,
            branchId: "branch_before_reset",
            documentId: DOCUMENT_ID,
            pushKind: "whole" as const,
            journalIds: [1],
            upstreamUpdateSeq: 1,
            receiptPayload: priorReceipt,
            idempotencyKey: "prior",
            threadId: THREAD_ID,
            turnId: TURN_ID,
          },
        ]),
        commitPush: vi.fn(async (input) => ({
          status: "inserted" as const,
          push: {
            id: 2,
            branchId: input.branch.branchId,
            documentId: input.branch.documentId,
            pushKind: "whole" as const,
            journalIds: input.journalRows.map((journalRow: BranchJournalRow) => journalRow.id),
            upstreamUpdateSeq: 2,
            receiptPayload: input.receiptPayload,
            idempotencyKey: input.idempotencyKey,
            threadId: THREAD_ID,
            turnId: TURN_ID,
          },
        })),
        countUnpushedRowsForWork: vi.fn(async () => 0),
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => []),
        updateWorkDraftPushPolicy: vi.fn(async () => undefined),
        markRollbackPending: vi.fn(async () => 0),
      },
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (_id, fn) => fn(liveDoc)),
        recover: vi.fn(async () => {}),
      },
      model,
      codec,
    });

    const result = await service.pushToLive({ branchId: branch.branchId });

    expect(result.status).toBe("pushed");
    expect(result.status === "pushed" ? result.conflictEcho : undefined).toBeUndefined();
  });
});

describe("thread-peer auto-push wiring", () => {
  it("auto policy propagates a thread-peer write to live with push lineage", async () => {
    const harness = new ThreadPeerPushHarness("auto");
    await harness.writeFromThreadPeer("Auto words.");

    await waitFor(() => harness.lineage.length === 1);
    expect(markdown(harness.liveDoc)).toContain("Auto words.");
    expect(harness.lineage[0]).toMatchObject({
      branchId: harness.work.branchId,
      documentId: DOCUMENT_ID,
      pushKind: "whole" as const,
      journalIds: [1],
    });
    expect(harness.rows[0].status).toBe("pushed");
  });

  it("manual policy leaves the write in the work draft and increments active row count", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    await harness.writeFromThreadPeer("Manual words.");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(markdown(harness.liveDoc)).not.toContain("Manual words.");
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Manual words.");
    expect(harness.rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(harness.lineage).toHaveLength(0);
  });

  it("attributes pulled concurrent rows as agent or human from branch journal metadata", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const agentDoc = cloneDoc(harness.liveDoc);
    appendParagraph(agentDoc, "Agent B words.");
    const humanDoc = cloneDoc(harness.liveDoc);
    appendParagraph(humanDoc, "Human live words.");
    harness.rows.push(
      {
        id: 1,
        branchId: harness.work.branchId,
        generation: harness.work.generation,
        wId: 1,
        source: "agent",
        threadId: "00000000-0000-4000-8000-000000000103" as ThreadId,
        turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
        actorUserId: null,
        updateData: Y.encodeStateAsUpdate(agentDoc),
        status: "active",
      },
      {
        id: 2,
        branchId: harness.work.branchId,
        generation: harness.work.generation,
        wId: null,
        source: "writer",
        threadId: null,
        turnId: null,
        actorUserId: USER_ID,
        updateData: Y.encodeStateAsUpdate(humanDoc),
        status: "active",
      },
    );
    const coordinator = harness.createAgentCoordinator();

    const updates = await coordinator.concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      sinceStateVector: Y.encodeStateVector(new Y.Doc({ gc: false })),
    });

    expect(updates?.map((update) => update.origin)).toEqual([
      { type: "agent", actorTurnId: "00000000-0000-4000-8000-000000000104" },
      { type: "human", userId: USER_ID },
    ]);
  });

  it("partitions journaled agent rows from unjournaled upstream human residuals", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const base = docFromUpdate(harness.work.state);
    const workAfterAgentOne = cloneDoc(base);
    appendParagraph(workAfterAgentOne, "R7 Beta untouched foreign-block B-R7-FOREIGN-AGENT.");
    const agentOneUpdate = Y.encodeStateAsUpdate(workAfterAgentOne, Y.encodeStateVector(base));
    const workAfterAgentTwo = cloneDoc(workAfterAgentOne);
    appendParagraph(workAfterAgentTwo, "R7 Delta tombstone foreign-block D-R7-FOREIGN-AGENT.");
    const deltaBlock = model.getBlocks(toDocHandle(workAfterAgentTwo)).at(-1);
    if (!deltaBlock) throw new Error("missing delta block");
    model.applyTextEdit(toDocHandle(workAfterAgentTwo), deltaBlock, { from: 9, to: 18 }, "");
    const agentTwoUpdate = Y.encodeStateAsUpdate(
      workAfterAgentTwo,
      Y.encodeStateVector(workAfterAgentOne),
    );
    const upstream = cloneDoc(workAfterAgentTwo);
    appendParagraph(upstream, "R7 Gamma human-zone HUMAN-R7-LIVE-EDIT.");
    harness.work.state = Y.encodeStateAsUpdate(upstream);
    harness.work.stateVector = Y.encodeStateVector(upstream);
    harness.rows.push(
      {
        id: 1,
        branchId: harness.work.branchId,
        generation: harness.work.generation,
        wId: 1,
        source: "agent",
        threadId: "00000000-0000-4000-8000-000000000103" as ThreadId,
        turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
        actorUserId: null,
        updateData: agentOneUpdate,
        status: "active",
      },
      {
        id: 2,
        branchId: harness.work.branchId,
        generation: harness.work.generation,
        wId: 2,
        source: "agent",
        threadId: "00000000-0000-4000-8000-000000000103" as ThreadId,
        turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
        actorUserId: null,
        updateData: agentTwoUpdate,
        status: "active",
      },
    );
    const coordinator = harness.createAgentCoordinator();
    const baseline = docFromUpdate(harness.thread.state);

    const updates = await coordinator.concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    expect(updates?.map((update) => update.origin)).toEqual([
      { type: "agent", actorTurnId: "00000000-0000-4000-8000-000000000104" },
      { type: "agent", actorTurnId: "00000000-0000-4000-8000-000000000104" },
      { type: "human" },
    ]);
    const agentProbe = docFromUpdate(harness.thread.state);
    Y.applyUpdate(agentProbe, updates?.[0]?.update ?? new Uint8Array());
    expect(markdown(agentProbe)).toContain("B-R7-FOREIGN-AGENT");
    expect(markdown(agentProbe)).not.toContain("HUMAN-R7-LIVE-EDIT");
    Y.applyUpdate(agentProbe, updates?.[1]?.update ?? new Uint8Array());
    expect(markdown(agentProbe)).toContain("D-R7-FOREIGN-AGENT");
    expect(markdown(agentProbe)).not.toContain("HUMAN-R7-LIVE-EDIT");
    Y.applyUpdate(agentProbe, updates?.[2]?.update ?? new Uint8Array());
    expect(markdown(agentProbe)).toContain("HUMAN-R7-LIVE-EDIT");
  });

  it("keeps a causally dependent agent row out of the human residual bucket", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const base = docFromUpdate(harness.work.state);
    const humanDoc = cloneDoc(base);
    const [humanBlock] = model.getBlocks(toDocHandle(humanDoc));
    if (!humanBlock) throw new Error("missing human block");
    model.applyTextEdit(
      toDocHandle(humanDoc),
      humanBlock,
      { from: "Base".length, to: "Base".length },
      " HUMAN-FRESH",
    );
    const agentDoc = cloneDoc(humanDoc);
    const [agentBlock] = model.getBlocks(toDocHandle(agentDoc));
    if (!agentBlock) throw new Error("missing agent block");
    model.applyTextEdit(
      toDocHandle(agentDoc),
      agentBlock,
      { from: "Base HUMAN-FRESH".length, to: "Base HUMAN-FRESH".length },
      " B-AGENT-CAUSAL",
    );
    const agentUpdate = Y.encodeStateAsUpdate(agentDoc, Y.encodeStateVector(humanDoc));
    harness.work.state = Y.encodeStateAsUpdate(agentDoc);
    harness.work.stateVector = Y.encodeStateVector(agentDoc);
    harness.rows.push({
      id: 1,
      branchId: harness.work.branchId,
      generation: harness.work.generation,
      wId: 1,
      source: "agent",
      threadId: "00000000-0000-4000-8000-000000000103" as ThreadId,
      turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
      actorUserId: null,
      updateData: agentUpdate,
      status: "active",
    });
    const coordinator = harness.createAgentCoordinator();
    const baseline = docFromUpdate(harness.thread.state);

    const updates = await coordinator.concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    expect(updates?.map((update) => update.origin)).toEqual([
      { type: "agent", actorTurnId: "00000000-0000-4000-8000-000000000104" },
      { type: "human" },
    ]);
    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(
      rendered.info?.renderedBlocks?.agent.some((line) => line.includes("B-AGENT-CAUSAL")),
    ).toBe(true);
    expect(rendered.info?.renderedBlocks?.human ?? []).toEqual([]);
    expect(markdown(probe)).toContain("HUMAN-FRESH B-AGENT-CAUSAL");
  });

  it("renders a human whole-block delete under human while a foreign agent insert stays agent", async () => {
    const harness = new ThreadPeerPushHarness("manual", "X baseline.\n\nY baseline.");
    const base = docFromUpdate(harness.work.state);
    const agentDoc = cloneDoc(base);
    appendParagraph(agentDoc, "Z foreign agent insert.");
    const agentUpdate = Y.encodeStateAsUpdate(agentDoc, Y.encodeStateVector(base));
    const upstream = cloneDoc(agentDoc);
    const [deletedBlock] = model.getBlocks(toDocHandle(upstream));
    if (!deletedBlock) throw new Error("missing block to delete");
    const deletedHash = model.getDocumentBlockIds(toDocHandle(upstream))[0];
    model.deleteBlock(toDocHandle(upstream), deletedBlock);
    harness.work.state = Y.encodeStateAsUpdate(upstream);
    harness.work.stateVector = Y.encodeStateVector(upstream);
    harness.rows.push({
      id: 1,
      branchId: harness.work.branchId,
      generation: harness.work.generation,
      wId: 1,
      source: "agent",
      threadId: "00000000-0000-4000-8000-000000000103" as ThreadId,
      turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
      actorUserId: null,
      updateData: agentUpdate,
      status: "active",
    });
    const coordinator = harness.createAgentCoordinator();
    const baseline = docFromUpdate(harness.thread.state);

    const updates = await coordinator.concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    expect(updates?.map((update) => update.origin)).toEqual([
      { type: "agent", actorTurnId: "00000000-0000-4000-8000-000000000104" },
      { type: "human" },
    ]);
    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(rendered.info?.renderedBlocks?.human).toContain(`${deletedHash}| (deleted)`);
    expect(
      rendered.info?.renderedBlocks?.agent.some((line) => line.includes("Z foreign agent insert.")),
    ).toBe(true);
    expect(rendered.info?.renderedBlocks?.agent).not.toContain(`${deletedHash}| (deleted)`);
  });

  it("renders a middle-block human deletion in a four-block pull with a foreign agent end insert", async () => {
    const harness = new ThreadPeerPushHarness(
      "manual",
      "A keep.\n\nB delete.\n\nC keep.\n\nD keep.",
    );
    const base = docFromUpdate(harness.work.state);
    const agentDoc = cloneDoc(base);
    appendParagraph(agentDoc, "E foreign agent end insert.");
    const agentUpdate = Y.encodeStateAsUpdate(agentDoc, Y.encodeStateVector(base));
    const upstream = cloneDoc(agentDoc);
    const deletedBlock = model.getBlocks(toDocHandle(upstream))[1];
    const deletedHash = model.getDocumentBlockIds(toDocHandle(upstream))[1];
    model.deleteBlock(toDocHandle(upstream), deletedBlock);
    harness.work.state = Y.encodeStateAsUpdate(upstream);
    harness.work.stateVector = Y.encodeStateVector(upstream);
    harness.rows.push({
      id: 1,
      branchId: harness.work.branchId,
      generation: harness.work.generation,
      wId: 1,
      source: "agent",
      threadId: "00000000-0000-4000-8000-000000000103" as ThreadId,
      turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
      actorUserId: null,
      updateData: agentUpdate,
      status: "active",
    });
    const baseline = docFromUpdate(harness.thread.state);
    const updates = await harness.createAgentCoordinator().concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(rendered.info?.renderedBlocks?.human).toContain(`${deletedHash}| (deleted)`);
    expect(
      rendered.info?.renderedBlocks?.agent.some((line) => line.includes("E foreign agent")),
    ).toBe(true);
  });

  it("reports the deleted block in a balanced human delete-edit-insert gap", async () => {
    const harness = new ThreadPeerPushHarness("manual", "X doomed.\n\nY original.\n\nZ stable.");
    const upstream = docFromUpdate(harness.work.state);
    const deletedBlock = model.getBlocks(toDocHandle(upstream))[0];
    const deletedHash = model.getDocumentBlockIds(toDocHandle(upstream))[0];
    model.deleteBlock(toDocHandle(upstream), deletedBlock);
    const yBlock = model.getBlocks(toDocHandle(upstream))[0];
    model.applyTextEdit(
      toDocHandle(upstream),
      yBlock,
      { from: 2, to: "Y original".length },
      "edited",
    );
    appendParagraph(upstream, "W inserted.");
    harness.work.state = Y.encodeStateAsUpdate(upstream);
    harness.work.stateVector = Y.encodeStateVector(upstream);
    const baseline = docFromUpdate(harness.thread.state);
    const updates = await harness.createAgentCoordinator().concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(rendered.info?.renderedBlocks?.human).toContain(`${deletedHash}| (deleted)`);
    expect(rendered.info?.renderedBlocks?.human.some((line) => line.includes("W inserted."))).toBe(
      true,
    );
  });

  it("reports an agent row deletion under that agent even when the row also has surviving coverage", async () => {
    const harness = new ThreadPeerPushHarness("manual", "X agent delete.\n\nY survives.");
    const base = docFromUpdate(harness.work.state);
    const agentDoc = cloneDoc(base);
    const deletedBlock = model.getBlocks(toDocHandle(agentDoc))[0];
    const deletedHash = model.getDocumentBlockIds(toDocHandle(agentDoc))[0];
    model.deleteBlock(toDocHandle(agentDoc), deletedBlock);
    appendParagraph(agentDoc, "Z agent survivor.");
    harness.work.state = Y.encodeStateAsUpdate(agentDoc);
    harness.work.stateVector = Y.encodeStateVector(agentDoc);
    harness.rows.push({
      id: 1,
      branchId: harness.work.branchId,
      generation: harness.work.generation,
      wId: 1,
      source: "agent",
      threadId: "00000000-0000-4000-8000-000000000103" as ThreadId,
      turnId: "00000000-0000-4000-8000-000000000104" as TurnId,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(agentDoc, Y.encodeStateVector(base)),
      status: "active",
    });
    const baseline = docFromUpdate(harness.thread.state);
    const updates = await harness.createAgentCoordinator().concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(rendered.info?.renderedBlocks?.agent).toContain(`${deletedHash}| (deleted)`);
    expect(
      rendered.info?.renderedBlocks?.agent.some((line) => line.includes("Z agent survivor.")),
    ).toBe(true);
    expect(rendered.info?.renderedBlocks?.human ?? []).not.toContain(`${deletedHash}| (deleted)`);
  });

  it("reports the correct near-duplicate human deletion hash without token pairing", async () => {
    const harness = new ThreadPeerPushHarness(
      "manual",
      "Boilerplate oath alpha.\n\nBoilerplate oath beta.\n\nTail.",
    );
    const upstream = docFromUpdate(harness.work.state);
    const deletedBlock = model.getBlocks(toDocHandle(upstream))[1];
    const deletedHash = model.getDocumentBlockIds(toDocHandle(upstream))[1];
    const survivorHash = model.getDocumentBlockIds(toDocHandle(upstream))[0];
    model.deleteBlock(toDocHandle(upstream), deletedBlock);
    harness.work.state = Y.encodeStateAsUpdate(upstream);
    harness.work.stateVector = Y.encodeStateVector(upstream);
    const baseline = docFromUpdate(harness.thread.state);
    const updates = await harness.createAgentCoordinator().concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(rendered.info?.human).toContain(deletedHash);
    expect(rendered.info?.human).not.toContain(survivorHash);
    expect(rendered.info?.renderedBlocks?.human).toContain(`${deletedHash}| (deleted)`);
  });

  it("reports both a human deletion and a similar human insertion", async () => {
    const harness = new ThreadPeerPushHarness("manual", "X ritual boilerplate.\n\nY stable.");
    const upstream = docFromUpdate(harness.work.state);
    const deletedBlock = model.getBlocks(toDocHandle(upstream))[0];
    const deletedHash = model.getDocumentBlockIds(toDocHandle(upstream))[0];
    model.deleteBlock(toDocHandle(upstream), deletedBlock);
    appendParagraph(upstream, "W ritual boilerplate rewritten.");
    harness.work.state = Y.encodeStateAsUpdate(upstream);
    harness.work.stateVector = Y.encodeStateVector(upstream);
    const baseline = docFromUpdate(harness.thread.state);
    const updates = await harness.createAgentCoordinator().concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(rendered.info?.renderedBlocks?.human).toContain(`${deletedHash}| (deleted)`);
    expect(
      rendered.info?.renderedBlocks?.human.some((line) =>
        line.includes("W ritual boilerplate rewritten."),
      ),
    ).toBe(true);
  });

  it("emits an unjournaled upstream residual as human even with no journal rows", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const upstream = docFromUpdate(harness.work.state);
    appendParagraph(upstream, "Human residual insert before deletion.");
    const deletedBlock = model.getBlocks(toDocHandle(upstream)).at(-1);
    if (!deletedBlock) throw new Error("missing residual block");
    model.deleteBlock(toDocHandle(upstream), deletedBlock);
    appendParagraph(upstream, "Human residual survivor.");
    harness.work.state = Y.encodeStateAsUpdate(upstream);
    harness.work.stateVector = Y.encodeStateVector(upstream);
    const coordinator = harness.createAgentCoordinator();
    const baseline = docFromUpdate(harness.thread.state);

    const updates = await coordinator.concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    expect(updates?.map((update) => update.origin)).toEqual([{ type: "human" }]);
    const probe = docFromUpdate(harness.thread.state);
    Y.applyUpdate(probe, updates?.[0]?.update ?? new Uint8Array());
    expect(markdown(probe)).toContain("Human residual survivor.");
    expect(markdown(probe)).not.toContain("Human residual insert before deletion.");
  });

  it("does not apply any branch-anchor floor to cold-start scans", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const base = docFromUpdate(harness.work.state);
    const beforeAnchorDoc = cloneDoc(base);
    appendParagraph(beforeAnchorDoc, "Before-floor row must not echo.");
    const afterAnchorDoc = cloneDoc(base);
    appendParagraph(afterAnchorDoc, "After-floor row must echo.");
    harness.rows.push(
      {
        id: 1,
        branchId: harness.work.branchId,
        generation: harness.work.generation,
        wId: 1,
        source: "agent",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actorUserId: null,
        updateData: Y.encodeStateAsUpdate(beforeAnchorDoc, Y.encodeStateVector(base)),
        status: "active",
      },
      {
        id: 2,
        branchId: harness.work.branchId,
        generation: harness.work.generation,
        wId: 2,
        source: "agent",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actorUserId: null,
        updateData: Y.encodeStateAsUpdate(afterAnchorDoc, Y.encodeStateVector(base)),
        status: "active",
      },
    );
    const coordinator = harness.createAgentCoordinator();
    const baseline = docFromUpdate(harness.thread.state);

    const updates = await coordinator.concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
    });

    expect(updates).toHaveLength(2);
    const probe = docFromUpdate(harness.thread.state);
    for (const update of updates ?? []) Y.applyUpdate(probe, update.update);
    expect(markdown(probe)).toContain("After-floor row must echo.");
    expect(markdown(probe)).toContain("Before-floor row must not echo.");
  });

  it("warns and drops mutation-less pending entries instead of retaining an undrainable batch", () => {
    const eventSink = createInMemoryEventSink();
    const pending = createBranchPendingJournalEntries(eventSink);

    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array(),
      meta: { origin: "agent:missing-mutation", seq: 0 },
    });

    expect(pending.shiftBatch(DOCUMENT_ID, THREAD_ID)).toEqual([]);
    expect(pending.shiftBatch(DOCUMENT_ID)).toEqual([]);
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        source: "collab.branch_pending_journal",
        name: "mutation_less_entry_dropped",
        payload: expect.objectContaining({
          documentId: DOCUMENT_ID,
          origin: "agent:missing-mutation",
        }),
      }),
    );
  });

  it("keeps a newer pending watermark when an older response commits late", () => {
    const watermarks = createBranchConcurrentJournalWatermarks();

    watermarks.capturePending(THREAD_ID, DOCUMENT_ID, 10, "attempt-a");
    watermarks.capturePending(THREAD_ID, DOCUMENT_ID, 11, "attempt-b");
    watermarks.commitPending(THREAD_ID, DOCUMENT_ID, "attempt-a");
    watermarks.commitPending(THREAD_ID, DOCUMENT_ID, "attempt-b");

    expect(watermarks.current(THREAD_ID, DOCUMENT_ID)).toBe(11);
  });

  it("promotes only the pending watermark captured by the committed attempt", () => {
    const watermarks = createBranchConcurrentJournalWatermarks();

    watermarks.capturePending(THREAD_ID, DOCUMENT_ID, 10, "abandoned-attempt");
    watermarks.commitPending(THREAD_ID, DOCUMENT_ID, "later-attempt");

    expect(watermarks.current(THREAD_ID, DOCUMENT_ID)).toBeUndefined();

    watermarks.clearPending(THREAD_ID, DOCUMENT_ID);
    watermarks.capturePending(THREAD_ID, DOCUMENT_ID, 11, "later-attempt");
    watermarks.commitPending(THREAD_ID, DOCUMENT_ID, "later-attempt");

    expect(watermarks.current(THREAD_ID, DOCUMENT_ID)).toBe(11);
  });

  it("promotes the captured watermark for a committed non-staged thread-peer write", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const watermarks = createBranchConcurrentJournalWatermarks();
    const pending = createBranchPendingJournalEntries();
    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array(),
      meta: { origin: "agent:test", seq: 0 },
      mutation: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        wId: 7,
        writeId: "attempt-non-staged",
        branchGeneration: harness.work.generation,
      },
    });
    const concurrentDoc = cloneDoc(harness.liveDoc);
    appendParagraph(concurrentDoc, "Concurrent row for non-staged floor.");
    harness.rows.push({
      id: 13,
      branchId: harness.work.branchId,
      generation: harness.work.generation,
      wId: 1,
      source: "agent",
      threadId: "00000000-0000-4000-8000-000000000099" as ThreadId,
      turnId: "00000000-0000-4000-8000-000000000098" as TurnId,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(concurrentDoc, Y.encodeStateVector(harness.liveDoc)),
      status: "active",
    });
    const coordinator = harness.createAgentCoordinator(pending, watermarks);

    await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      await coordinator.concurrentUpdatesSince?.({
        docId: DOCUMENT_ID,
        doc,
        baselineDoc: docFromUpdate(harness.thread.state),
        sinceStateVector: Y.encodeStateVector(docFromUpdate(harness.thread.state)),
        attemptId: "attempt-non-staged",
      });
      appendParagraph(doc, "Non-staged write body.");
    });

    expect(watermarks.current(THREAD_ID, DOCUMENT_ID)).toBe(13);
  });

  it("drains a staged document batch as one commit and promotes the last captured attempt", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const watermarks = createBranchConcurrentJournalWatermarks();
    const pending = createBranchPendingJournalEntries();
    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array(),
      meta: { origin: "agent:first", seq: 0 },
      mutation: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        wId: 1,
        writeId: "attempt-first",
        branchGeneration: harness.work.generation,
      },
    });
    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array(),
      meta: { origin: "agent:last", seq: 0 },
      mutation: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        wId: 2,
        writeId: "attempt-last",
        branchGeneration: harness.work.generation,
      },
    });
    const concurrentDoc = cloneDoc(harness.liveDoc);
    appendParagraph(concurrentDoc, "Concurrent row for staged floor.");
    harness.rows.push({
      id: 21,
      branchId: harness.work.branchId,
      generation: harness.work.generation,
      wId: 1,
      source: "agent",
      threadId: "00000000-0000-4000-8000-000000000097" as ThreadId,
      turnId: "00000000-0000-4000-8000-000000000096" as TurnId,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(concurrentDoc, Y.encodeStateVector(harness.liveDoc)),
      status: "active",
    });
    const coordinator = harness.createAgentCoordinator(pending, watermarks);

    await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      await coordinator.concurrentUpdatesSince?.({
        docId: DOCUMENT_ID,
        doc,
        baselineDoc: docFromUpdate(harness.thread.state),
        sinceStateVector: Y.encodeStateVector(docFromUpdate(harness.thread.state)),
        attemptId: "attempt-last",
      });
      appendParagraph(doc, "Staged write one.");
      appendParagraph(doc, "Staged write two.");
    });

    expect(watermarks.current(THREAD_ID, DOCUMENT_ID)).toBe(21);
    expect(harness.rows.at(-1)).toEqual(expect.objectContaining({ wId: 2, turnId: TURN_ID }));
  });

  it("keeps concurrent rows below the floor when the surrounding write fails", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const agentDoc = cloneDoc(harness.liveDoc);
    appendParagraph(agentDoc, "Retry-visible concurrent row.");
    harness.rows.push({
      id: 1,
      branchId: harness.work.branchId,
      generation: harness.work.generation,
      wId: 1,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(agentDoc, Y.encodeStateVector(harness.liveDoc)),
      status: "active",
    });
    harness.failNextCommitSync = true;
    const coordinator = harness.createAgentCoordinator();
    const interactionBaselineState = harness.thread.state;

    const first = await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      const updates = await coordinator.concurrentUpdatesSince?.({
        docId: DOCUMENT_ID,
        doc,
        baselineDoc: docFromUpdate(interactionBaselineState),
        sinceStateVector: Y.encodeStateVector(new Y.Doc({ gc: false })),
      });
      appendParagraph(doc, "failed write body");
      return updates;
    });
    const second = await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      const updates = await coordinator.concurrentUpdatesSince?.({
        docId: DOCUMENT_ID,
        doc,
        baselineDoc: docFromUpdate(interactionBaselineState),
        sinceStateVector: Y.encodeStateVector(new Y.Doc({ gc: false })),
      });
      appendParagraph(doc, "successful write body");
      return updates;
    });

    expect(first?.map((update) => update.origin)).toEqual([
      { type: "agent", actorTurnId: TURN_ID },
    ]);
    expect(second?.map((update) => update.origin)).toEqual([
      { type: "agent", actorTurnId: TURN_ID },
    ]);
  });

  it("does not journal or auto-push read-only thread-peer access", async () => {
    const harness = new ThreadPeerPushHarness("auto");

    await harness.readFromThreadPeer();

    expect(harness.rows).toHaveLength(0);
    expect(harness.lineage).toHaveLength(0);
    expect(markdown(harness.liveDoc)).toBe("Base.\n");
  });

  it("derives a turn change diff for discarded rows from an old branch generation", async () => {
    const harness = new ThreadPeerPushHarness("manual");

    await harness.writeFromThreadPeer("Discarded draft words.");
    const [row] = harness.rows;
    expect(row).toEqual(expect.objectContaining({ status: "active", turnId: TURN_ID }));
    row.status = "discarded";
    await harness.branchCoordinator.resetFromDocIfUnchanged({
      upstream: harness.liveDoc,
    });

    const diff = await harness.branchPush.getTurnChangeDiff({
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    expect(harness.work.generation).toBe(row.generation + 1);
    expect(diff.source).toBe("branch");
    expect(diff.documents).toEqual([
      {
        documentId: DOCUMENT_ID,
        documentTitle: "Untitled document",
        blocks: [
          expect.objectContaining({
            beforeText: null,
            afterText: "Discarded draft words.",
          }),
        ],
      },
    ]);
  });

  it("rejects an in-flight thread-peer write after a no-change pull generation is reset", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const pending = createBranchPendingJournalEntries();
    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array(),
      meta: { origin: "agent:stale", seq: 0 },
      mutation: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        wId: 1,
        writeId: "attempt-stale",
        branchGeneration: harness.work.generation,
      },
    });
    harness.work.generation += 1;
    const coordinator = harness.createAgentCoordinator(pending);

    await expect(
      coordinator.withDocument(DOCUMENT_ID, async (doc) => {
        appendParagraph(doc, "Stale write should not commit.");
      }),
    ).rejects.toThrow("stale_branch_generation");
    expect(harness.rows).toHaveLength(0);
  });

  it("keeps the write and active rows when auto-push fails so the next push retries", async () => {
    const harness = new ThreadPeerPushHarness("auto");
    harness.failNextCommitPush = true;

    await expect(harness.writeFromThreadPeer("Retry words.")).resolves.toBeUndefined();
    await waitFor(() => harness.failedPushes === 1);

    expect(markdown(harness.liveDoc)).not.toContain("Retry words.");
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Retry words.");
    expect(harness.rows.filter((row) => row.status === "active")).toHaveLength(1);

    await expect(
      harness.branchPush.pushToLive({ branchId: harness.work.branchId }),
    ).resolves.toMatchObject({
      status: "pushed",
    });
    expect(markdown(harness.liveDoc)).toContain("Retry words.");
    expect(harness.rows[0].status).toBe("pushed");
    expect(harness.lineage).toHaveLength(1);
  });
});

class ThreadPeerPushHarness {
  readonly journal = createInMemoryJournal();
  readonly liveDoc: Y.Doc;
  readonly work: BranchSnapshot;
  readonly thread: BranchSnapshot;
  readonly rows: BranchJournalRow[] = [];
  readonly lineage: PushLineageRow[] = [];
  failNextCommitPush = false;
  failNextCommitSync = false;
  failedPushes = 0;

  readonly branchStore: BranchStore = {
    getBranch: vi.fn(async (branchId: string) => {
      if (branchId === this.work.branchId) return this.work;
      if (branchId === this.thread.branchId) return this.thread;
      return null;
    }),
    updateBranchSnapshot: vi.fn(async () => true),
  };

  readonly branchCoordinator = {
    withBranch: vi.fn(),
    pullFromDoc: vi.fn(),
    pullFromBranch: vi.fn(),
    resetFromDoc: vi.fn(),
    resetFromDocIfUnchanged: vi.fn(async (input: { upstream: Y.Doc }) => {
      this.work.generation += 1;
      this.work.state = Y.encodeStateAsUpdate(input.upstream);
      this.work.stateVector = Y.encodeStateVector(input.upstream);
      return true;
    }),
    resetFromBranch: vi.fn(),
    checkpointBranch: vi.fn(),
    withBranchTransient: vi.fn(
      async (branchId: string, fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<unknown>) => {
        const snapshot = this.snapshot(branchId);
        const doc = docFromUpdate(snapshot.state);
        const result = await fn(doc, snapshot);
        snapshot.state = Y.encodeStateAsUpdate(doc);
        snapshot.stateVector = Y.encodeStateVector(doc);
        return result;
      },
    ),
    readBranch: vi.fn(
      async (branchId: string, fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<unknown>) => {
        const snapshot = this.snapshot(branchId);
        const doc = docFromUpdate(snapshot.state);
        try {
          return await fn(doc, snapshot);
        } finally {
          doc.destroy();
        }
      },
    ),
    appendJournaledUpdate: vi.fn(),
    commitSyncFromDoc: vi.fn(
      async (input: {
        branchId: string;
        sourceDoc: Y.Doc;
        wId?: number | null;
        threadId?: ThreadId | null;
        turnId?: TurnId | null;
        expectedGeneration: number;
      }) => {
        if (this.failNextCommitSync) {
          this.failNextCommitSync = false;
          return false;
        }
        const snapshot = this.snapshot(input.branchId);
        if (snapshot.generation !== input.expectedGeneration) {
          throw new Error("stale_branch_generation");
        }
        const doc = docFromUpdate(snapshot.state);
        const updateData = Y.encodeStateAsUpdate(input.sourceDoc, Y.encodeStateVector(doc));
        Y.applyUpdate(doc, updateData);
        snapshot.state = Y.encodeStateAsUpdate(doc);
        snapshot.stateVector = Y.encodeStateVector(doc);
        this.rows.push({
          id: this.rows.length + 1,
          branchId: snapshot.branchId,
          generation: snapshot.generation,
          wId: input.wId ?? null,
          source: "agent",
          threadId: input.threadId ?? null,
          turnId: input.turnId ?? null,
          actorUserId: null,
          updateData,
          status: "active",
        });
        return true;
      },
    ),
    commitUpdate: vi.fn(
      async (input: {
        branchId: string;
        updateData: Uint8Array;
        wId?: number | null;
        threadId?: ThreadId | null;
        turnId?: TurnId | null;
        expectedGeneration: number;
      }) => {
        const snapshot = this.snapshot(input.branchId);
        const doc = docFromUpdate(snapshot.state);
        Y.applyUpdate(doc, input.updateData);
        snapshot.state = Y.encodeStateAsUpdate(doc);
        snapshot.stateVector = Y.encodeStateVector(doc);
        this.rows.push({
          id: this.rows.length + 1,
          branchId: snapshot.branchId,
          generation: snapshot.generation,
          wId: input.wId ?? null,
          source: "agent",
          threadId: input.threadId ?? null,
          turnId: input.turnId ?? null,
          actorUserId: null,
          updateData: input.updateData,
          status: "active",
        });
      },
    ),
  };

  readonly branchPush = createBranchPushService({
    branchStore: this.branchStore,
    pushStore: {
      listActiveJournalRows: vi.fn(async (branchId, generation) =>
        this.rows.filter(
          (row) =>
            row.branchId === branchId && row.generation === generation && row.status === "active",
        ),
      ),
      listConcurrentJournalRows: vi.fn(
        listConcurrentJournalRowsInMemory(this.rows, (branchId) => this.snapshot(branchId)),
      ),
      listJournalRowsForTurn: vi.fn(async (input) =>
        this.rows.filter(
          (row) =>
            row.threadId === input.threadId &&
            row.turnId === input.turnId &&
            (input.branchId === undefined || row.branchId === input.branchId) &&
            (input.generation === undefined || row.generation === input.generation) &&
            (!input.statuses || input.statuses.includes(row.status)),
        ),
      ),
      listJournalRowsForBranch: vi.fn(async (input) =>
        this.rows.filter(
          (row) =>
            row.branchId === input.branchId &&
            row.generation === input.generation &&
            (input.throughJournalId === undefined || row.id <= input.throughJournalId),
        ),
      ),
      latestPushForBranch: vi.fn(async () => this.lineage.at(-1) ?? null),
      commitPush: vi.fn(async (input) => {
        if (this.failNextCommitPush) {
          this.failNextCommitPush = false;
          this.failedPushes += 1;
          throw new Error("push store unavailable");
        }
        const seq = await this.journal.append(input.branch.documentId, input.pushUpdate, {
          origin: `push:${input.branch.branchId}`,
          seq: 0,
        });
        const push: PushLineageRow = {
          id: this.lineage.length + 1,
          branchId: input.branch.branchId,
          documentId: input.branch.documentId,
          pushKind: "whole" as const,
          journalIds: input.journalRows.map((row: BranchJournalRow) => row.id),
          upstreamUpdateSeq: seq,
          receiptPayload: input.receiptPayload,
          idempotencyKey: input.idempotencyKey,
        };
        this.lineage.push(push);
        for (const row of input.journalRows) row.status = "pushed";
        return { status: "inserted" as const, push };
      }),
      countUnpushedRowsForWork: vi.fn(
        async () => this.rows.filter((row) => row.status === "active").length,
      ),
      listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [this.work.branchId]),
      updateWorkDraftPushPolicy: vi.fn(async (_workId, policy) => {
        this.work.pushPolicy = policy;
      }),
      markRollbackPending: vi.fn(async () => 0),
    },
    branchCoordinator: this.branchCoordinator,
    journal: this.journal,
    liveCoordinator: {
      withDocument: vi.fn(async (_docId, fn) => fn(this.liveDoc)),
      recover: vi.fn(async () => undefined),
    },
    model,
    codec,
  });

  constructor(policy: "manual" | "auto", seedMarkdown = "Base.") {
    this.liveDoc = docFromMarkdown(seedMarkdown);
    this.work = { ...makeBranch(cloneDoc(this.liveDoc)), pushPolicy: policy };
    this.thread = {
      ...makeBranch(cloneDoc(this.liveDoc)),
      branchId: "branch_thread",
      kind: "thread_peer",
      upstreamBranchId: this.work.branchId,
      threadId: THREAD_ID,
      pushPolicy: policy,
    };
    void this.journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(this.liveDoc), {
      origin: "system",
      seq: 0,
    });
  }

  async readFromThreadPeer(): Promise<void> {
    const coordinator = this.createAgentCoordinator();
    await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      markdown(doc);
    });
  }

  async writeFromThreadPeer(text: string): Promise<void> {
    const pending = createBranchPendingJournalEntries();
    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array(),
      meta: { origin: "agent:test", seq: 0 },
      mutation: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        wId: this.rows.length + 1,
        writeId: "w",
        branchGeneration: this.work.generation,
      },
    });
    const coordinator = this.createAgentCoordinator(pending);
    await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      appendParagraph(doc, text);
    });
  }

  createAgentCoordinator(
    pending?: ReturnType<typeof createBranchPendingJournalEntries>,
    watermarks?: ReturnType<typeof createBranchConcurrentJournalWatermarks>,
  ) {
    return createBranchAgentEditCoordinator({
      threadId: THREAD_ID,
      liveCoordinator: {
        withDocument: vi.fn(async (_docId, fn) => fn(this.liveDoc)),
        recover: vi.fn(),
      },
      branchCoordinator: this.branchCoordinator as unknown as BranchCoordinator,
      branches: {
        resolveThreadBranch: async () => ({
          branchId: this.thread.branchId,
          doc: docFromUpdate(this.thread.state),
          generation: this.thread.generation,
        }),
        ensureThreadPeerBranch: async () => this.thread,
        ensureWorkDraftBranch: async () => this.work,
        listActiveWorkDraftBranchIds: async () => [this.work.branchId],
        getBranch: async (branchId: string) => this.branchStore.getBranch(branchId),
      },
      pendingJournalEntries: pending,
      branchPush: this.branchPush,
      model,
      codec: agentCodec,
      ...(watermarks ? { concurrentJournalWatermarks: watermarks } : {}),
      journalRows: {
        listActiveJournalRows: async (branchId: string, generation: number) =>
          this.rows.filter(
            (row) =>
              row.branchId === branchId && row.generation === generation && row.status === "active",
          ),
        listConcurrentJournalRows: listConcurrentJournalRowsInMemory(this.rows, (branchId) =>
          this.snapshot(branchId),
        ),
      },
    });
  }

  private snapshot(branchId: string): BranchSnapshot {
    if (branchId === this.work.branchId) return this.work;
    if (branchId === this.thread.branchId) return this.thread;
    throw new Error(`Unknown branch ${branchId}`);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
