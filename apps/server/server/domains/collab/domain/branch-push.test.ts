/** Unit coverage for durable-first branch push lifecycle. */

import {
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
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import {
  createBranchAgentEditCoordinator,
  createBranchPendingJournalEntries,
} from "./branch-agent-edit.js";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import {
  type BranchJournalRow,
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
  };
  readonly lineage: PushLineageRow[] = [];
  policy: "manual" | "auto" = "manual";
  failApply = false;
  readonly pushStore: BranchPushStore = {
    listActiveJournalRows: vi.fn(async () => (this.row.status === "active" ? [this.row] : [])),
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
      { type: "agent", actorTurnId: "00000000-0000-4000-8000-000000000104" },
    ]);
    const probe = docFromUpdate(harness.thread.state);
    for (const update of updates ?? []) Y.applyUpdate(probe, update.update);
    expect(markdown(probe)).toContain("HUMAN-FRESH B-AGENT-CAUSAL");
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

    const first = await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      const updates = await coordinator.concurrentUpdatesSince?.({
        docId: DOCUMENT_ID,
        doc,
        baselineDoc: docFromUpdate(harness.thread.state),
        sinceStateVector: Y.encodeStateVector(new Y.Doc({ gc: false })),
      });
      appendParagraph(doc, "failed write body");
      return updates;
    });
    const second = await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      const updates = await coordinator.concurrentUpdatesSince?.({
        docId: DOCUMENT_ID,
        doc,
        baselineDoc: docFromUpdate(harness.thread.state),
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
  readonly liveDoc = docFromMarkdown("Base.");
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
      }) => {
        if (this.failNextCommitSync) {
          this.failNextCommitSync = false;
          return false;
        }
        const snapshot = this.snapshot(input.branchId);
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

  constructor(policy: "manual" | "auto") {
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
      mutation: { threadId: THREAD_ID, turnId: TURN_ID, wId: this.rows.length + 1, writeId: "w" },
    });
    const coordinator = this.createAgentCoordinator(pending);
    await coordinator.withDocument(DOCUMENT_ID, async (doc) => {
      appendParagraph(doc, text);
    });
  }

  createAgentCoordinator(pending?: ReturnType<typeof createBranchPendingJournalEntries>) {
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
      journalRows: {
        listActiveJournalRows: async (branchId: string, generation: number) =>
          this.rows.filter(
            (row) =>
              row.branchId === branchId && row.generation === generation && row.status === "active",
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
