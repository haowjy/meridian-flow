/** Unit coverage for durable-first branch push lifecycle. */

import { type DocumentCoordinator, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import type { BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import {
  type BranchJournalRow,
  type BranchPushStore,
  createBranchPushService,
  type PushLineageRow,
} from "./branch-push.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000002" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000003" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000004" as TurnId;

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

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
        pushKind: "whole",
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

  it("requires confirmation before manual to auto when unpushed rows exist and flips after pushing", async () => {
    const harness = new Harness();
    await harness.init();
    const service = harness.service();

    await expect(
      service.setWorkPushPolicy({ workId: WORK_ID, policy: "auto" }),
    ).resolves.toMatchObject({ status: "confirmation_required", unpushedCount: 1 });
    expect(harness.policy).toBe("manual");

    await expect(
      service.setWorkPushPolicy({ workId: WORK_ID, policy: "auto", confirmedPush: true }),
    ).resolves.toEqual({ status: "updated", policy: "auto" });
    expect(harness.lineage).toHaveLength(1);
    expect(harness.policy).toBe("auto");
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
});
