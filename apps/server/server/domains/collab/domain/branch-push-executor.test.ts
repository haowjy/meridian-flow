/** Unit coverage for durable-first branch push lifecycle. */

import {
  type AgentEditCore,
  applyConcurrentUpdates,
  createAgentEditCodec,
  createAgentEditCore,
  type DocumentCoordinator,
  snapshotBlocks,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import type { NoticePort } from "../../notices/index.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createBranchAgentEditDiagnostics } from "../adapters/branch-agent-edit-observability.js";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import { createThreadPeerAgentEditCore } from "../composition.js";
import { asLiveAgentEditCore } from "./agent-edit-cores.js";
import {
  createBranchAgentEditCoordinator,
  createBranchAgentEditJournal,
  createBranchConcurrentJournalWatermarks,
  createBranchPendingJournalEntries,
  StagedBranchWriteNoopError,
} from "./branch-agent-edit.js";
import type { BranchCoordinator, BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import { createBranchCriticalSections } from "./branch-critical-sections.js";
import {
  type BranchJournalRow,
  BranchPeerIntegrationError,
  BranchPushCommitConflictError,
  BranchPushRetryExhaustedError,
  type BranchPushStore,
  createBranchPushService,
  type PendingLiveSettlement,
  type PushLineageRow,
} from "./branch-push.js";
import { branchJournalRevision } from "./branch-push-contracts.js";
import { activeBranchAgentWriteRows } from "./branch-reversal-history.js";
import { persistDurableTrailRecord } from "./branch-trail-projection.js";
import type {
  ChangeTrailPersistence,
  DurableTrailRecord,
} from "./ports/change-trail-persistence.js";

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

/** Mirrors the production cold reader for rows created before response sealing. */
function withDurableWriterProvenance(pending: PendingLiveSettlement): PendingLiveSettlement {
  const durable = docFromUpdate(pending.lockCutUpdate);
  try {
    for (const update of pending.postCutUpdates) Y.applyUpdate(durable, update);
    return {
      ...pending,
      provenanceView: snapshotBlocks(toDocHandle(durable), model, agentCodec).flatMap((block) =>
        (block.lineage ?? []).map((range) => ({
          target: range,
          root: range,
          birthClass: "writer_protected" as const,
        })),
      ),
    };
  } finally {
    durable.destroy();
  }
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

function prefixWideningFixture(): {
  liveDoc: Y.Doc;
  collisionUpdate: Uint8Array;
  initialTargetHash: string;
} {
  const pool = createCollabYDoc({ gc: false });
  const updates: Uint8Array[] = [];
  for (let index = 0; index < 800; index += 1) {
    const candidate = createCollabYDoc({ gc: false });
    candidate.clientID = index + 10_000;
    model.insertBlocks(toDocHandle(candidate), null, codec.parse(`Collision candidate ${index}.`));
    const update = Y.encodeStateAsUpdate(candidate);
    updates.push(update);
    Y.applyUpdate(pool, update);
    candidate.destroy();
  }
  const candidates = model.getBlocks(toDocHandle(pool)).map((block, index) => ({
    block,
    index,
    hash: model.getBlockId(block),
  }));
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const prefix = candidate.hash.slice(0, 4);
    groups.set(prefix, [...(groups.get(prefix) ?? []), candidate]);
  }
  const pair = [...groups.values()].find(
    (matches) =>
      matches.length > 1 &&
      matches.every((candidate) => candidate.hash.length > 4) &&
      new Set(matches.map((candidate) => candidate.hash)).size === matches.length,
  );
  if (!pair?.[0] || !pair[1]) throw new Error("failed to generate a display-prefix collision");

  const liveDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(liveDoc, updates[pair[0].index] as Uint8Array);
  const target = model.getBlocks(toDocHandle(liveDoc))[0];
  if (!target) throw new Error("collision fixture target is missing");
  const initialTargetHash = model.getBlockId(target);
  if (initialTargetHash.length !== 4) throw new Error("collision target did not start short");
  pool.destroy();
  return {
    liveDoc,
    collisionUpdate: updates[pair[1].index] as Uint8Array,
    initialTargetHash,
  };
}

type ListJournalRowsForTurnInput = Parameters<
  NonNullable<BranchPushStore["listJournalRowsForTurn"]>
>[0];

/**
 * One copy of the store's listJournalRowsForTurn filter contract. Per-test
 * inline fakes drifted (some dropped the branchId/generation fences), letting
 * a fake accept rows production would never return.
 */
function rowsForTurn(
  rows: readonly BranchJournalRow[],
  input: ListJournalRowsForTurnInput,
): BranchJournalRow[] {
  return rows.filter(
    (row) =>
      row.threadId === input.threadId &&
      row.turnId === input.turnId &&
      (input.branchId === undefined || row.branchId === input.branchId) &&
      (input.generation === undefined || row.generation === input.generation) &&
      (!input.statuses || input.statuses.includes(row.status)),
  );
}

class Harness {
  private trailPersistence?: ChangeTrailPersistence;
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
    draftBaseUpdateSeq: 1,
    status: "active",
  };
  readonly branchStore: BranchStore = {
    deferUntilCommit: (callback) => {
      callback();
      return true;
    },
    getBranch: vi.fn(async () => this.branch),
    updateBranchSnapshot: vi.fn(async () => true),
  };
  readonly branchCoordinator = {
    resetFromDocIfUnchangedWithLease: vi.fn(
      async (_lease: unknown, _input: { branchId: string; upstream: Y.Doc }) => {
        const upstream = _input.upstream;
        this.branch.generation += 1;
        this.branch.state = Y.encodeStateAsUpdate(upstream);
        this.branch.stateVector = Y.encodeStateVector(upstream);
        return true;
      },
    ),
    broadcastUpdate: vi.fn(),
  };
  readonly lineage: PushLineageRow[] = [];
  policy: "manual" | "auto" = "manual";
  failApply = false;
  readonly pushStore: BranchPushStore = {
    listActiveJournalRows: vi.fn(async () => (this.row.status === "active" ? [this.row] : [])),
    listJournalRowsForTurn: vi.fn(async (input) => rowsForTurn([this.row], input)),
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
      if (this.trailPersistence) {
        await persistDurableTrailRecord(input.trail, push, this.trailPersistence);
      }
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

  service(changeTrails?: ChangeTrailPersistence, safety?: { notices?: NoticePort }) {
    this.trailPersistence = changeTrails;
    return createBranchPushService({
      branchStore: this.branchStore,
      pushStore: this.pushStore,
      branchCoordinator: this.branchCoordinator,
      journal: this.journal,
      liveCoordinator: this.coordinator,
      model,
      codec,
      notices: safety?.notices,
    });
  }
}

describe("createBranchPushService", () => {
  it("judges selected rows from their own immutable draft bases", async () => {
    const liveDoc = docFromMarkdown("Alpha base.\n\nBeta base.");
    const branchDoc = cloneDoc(liveDoc);
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), { origin: "system", seq: 0 });

    const [branchAlpha] = model.getBlocks(toDocHandle(branchDoc));
    if (!branchAlpha) throw new Error("missing alpha block");
    const beforeAlpha = Y.encodeStateVector(branchDoc);
    model.applyTextEdit(toDocHandle(branchDoc), branchAlpha, { from: 0, to: 5 }, "Agent alpha");
    const rowAUpdate = Y.encodeStateAsUpdate(branchDoc, beforeAlpha);

    const liveBeta = model.getBlocks(toDocHandle(liveDoc))[1];
    if (!liveBeta) throw new Error("missing beta block");
    const beforeWriter = Y.encodeStateVector(liveDoc);
    model.applyTextEdit(toDocHandle(liveDoc), liveBeta, { from: 0, to: 4 }, "Writer beta");
    const writerUpdate = Y.encodeStateAsUpdate(liveDoc, beforeWriter);
    const writerSeq = await journal.append(DOCUMENT_ID, writerUpdate, {
      origin: "human:writer",
      seq: 0,
    });
    Y.applyUpdate(branchDoc, writerUpdate);

    const branchBeta = model.getBlocks(toDocHandle(branchDoc))[1];
    if (!branchBeta) throw new Error("missing beta block after pull");
    const beforeBeta = Y.encodeStateVector(branchDoc);
    model.applyTextEdit(
      toDocHandle(branchDoc),
      branchBeta,
      { from: model.getText(branchBeta).length, to: model.getText(branchBeta).length },
      " + agent",
    );
    const rows: BranchJournalRow[] = [
      {
        id: 10,
        branchId: "branch_mixed",
        generation: 1,
        wId: 1,
        source: "agent",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actorUserId: null,
        updateData: rowAUpdate,
        draftBaseUpdateSeq: 1,
        status: "active",
      },
      {
        id: 11,
        branchId: "branch_mixed",
        generation: 1,
        wId: 1,
        source: "agent",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actorUserId: null,
        updateData: Y.encodeStateAsUpdate(branchDoc, beforeBeta),
        draftBaseUpdateSeq: writerSeq,
        status: "active",
      },
    ];
    const branch = { ...makeBranch(branchDoc), branchId: "branch_mixed" };
    const service = createBranchPushService({
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => branch,
        updateBranchSnapshot: async () => true,
      },
      pushStore: {
        listActiveJournalRows: async () => rows,
        listConcurrentJournalRows: async () => [],
        latestPushForBranch: async () => null,
        commitPush: async (prepared) => ({
          status: "inserted",
          push: {
            id: 1,
            branchId: branch.branchId,
            documentId: DOCUMENT_ID,
            pushKind: "selective",
            journalIds: rows.map((row) => row.id),
            upstreamUpdateSeq: writerSeq,
            receiptPayload: prepared.receiptPayload,
            idempotencyKey: prepared.idempotencyKey,
          },
        }),
        countUnpushedRowsForWork: async () => 2,
        listActiveWorkDraftBranchIdsForWork: async () => [branch.branchId],
        updateWorkDraftPushPolicy: async () => {},
        markRollbackPending: async () => 0,
      },
      journal,
      liveCoordinator: { withDocument: async (_id, run) => run(liveDoc), recover: async () => {} },
      model,
      codec,
    });

    await expect(
      service.pushSelectedToLive({ branchId: branch.branchId, journalIds: [10, 11] }),
    ).resolves.toMatchObject({ status: "pushed" });
    expect(markdown(liveDoc)).toContain("Writer beta base. + agent");
  });

  it("keeps draftBase immutable when repeated manual Apply attempts refuse stale divergence", async () => {
    const harness = new Harness();
    await harness.init();
    const draftBlock = model.getBlocks(toDocHandle(harness.branchDoc))[0];
    if (!draftBlock) throw new Error("missing draft block");
    const beforeDraftDelete = Y.encodeStateVector(harness.branchDoc);
    model.deleteBlock(toDocHandle(harness.branchDoc), draftBlock);
    harness.row.updateData = Y.encodeStateAsUpdate(harness.branchDoc, beforeDraftDelete);
    harness.branch.state = Y.encodeStateAsUpdate(harness.branchDoc);
    harness.branch.stateVector = Y.encodeStateVector(harness.branchDoc);
    const block = model.getBlocks(toDocHandle(harness.liveDoc))[0];
    if (!block) throw new Error("missing live block");
    const before = Y.encodeStateVector(harness.liveDoc);
    model.applyTextEdit(toDocHandle(harness.liveDoc), block, { from: 0, to: 0 }, "Writer: ");
    await harness.journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(harness.liveDoc, before), {
      origin: "human:user-2",
      seq: 0,
    });
    const draftBase = harness.row.draftBaseUpdateSeq;

    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).resolves.toMatchObject({
      status: "push_concurrent_conflict",
      reason: "draft_base_divergence",
    });
    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).resolves.toMatchObject({
      status: "push_concurrent_conflict",
      reason: "draft_base_divergence",
    });

    expect(harness.row.draftBaseUpdateSeq).toBe(draftBase);
    expect(harness.row.status).toBe("active");
  });

  it.each([
    "manual",
    "auto",
  ] as const)("does not claim %s resurrection from equal prose alone", async (policy) => {
    const harness = new Harness();
    await harness.init();
    harness.branch.pushPolicy = policy;
    const liveBase = model.getBlocks(toDocHandle(harness.liveDoc))[0];
    if (!liveBase) throw new Error("missing live base block");
    const beforeDelete = Y.encodeStateVector(harness.liveDoc);
    model.deleteBlock(toDocHandle(harness.liveDoc), liveBase);
    await harness.journal.append(
      DOCUMENT_ID,
      Y.encodeStateAsUpdate(harness.liveDoc, beforeDelete),
      { origin: "human:user-2", seq: 0 },
    );
    model.insertBlocks(toDocHandle(harness.branchDoc), null, codec.parse("Base."));
    harness.branch.state = Y.encodeStateAsUpdate(harness.branchDoc);
    harness.branch.stateVector = Y.encodeStateVector(harness.branchDoc);
    const notices = {
      record: vi.fn(async () => {}),
      drainForModelContext: vi.fn(async () => []),
      drainForWriter: vi.fn(async () => []),
      subscribeWriterVisible: vi.fn(() => () => {}),
    } satisfies NoticePort;
    const record = vi.fn(async () => {});
    const service = harness.service({ record, reopenOwners: vi.fn() }, { notices });

    const result =
      policy === "auto"
        ? await service.pushAutoBranchAfterThreadPeerWrite({
            workDraftBranchId: harness.branch.branchId,
          })
        : await service.pushToLive({ branchId: harness.branch.branchId });

    expect(result).toMatchObject({ status: "pushed" });
    expect(result.status === "pushed" ? result.swept : undefined).toBeUndefined();
    expect(harness.row.status).toBe("pushed");
    expect(record).not.toHaveBeenCalledWith(
      expect.objectContaining({
        trails: expect.arrayContaining([
          expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({ writerProtection: { kind: "resurrection" } }),
            ]),
          }),
        ]),
      }),
    );
  });

  it("attributes ordinary receipt blocks to their exact journal rows", async () => {
    const harness = new Harness();
    await harness.init();
    const secondTurnId = "00000000-0000-4000-8000-000000000006" as TurnId;
    const secondUpdate = appendParagraph(harness.branchDoc, "Other turn words.");
    harness.branch.state = Y.encodeStateAsUpdate(harness.branchDoc);
    harness.branch.stateVector = Y.encodeStateVector(harness.branchDoc);
    const rows = [
      harness.row,
      { ...harness.row, id: 2, wId: 2, turnId: secondTurnId, updateData: secondUpdate },
    ];
    harness.pushStore.listActiveJournalRows = vi.fn(async () => rows);
    const record = vi.fn();
    harness.pushStore.commitPush = vi.fn(async (input) => {
      const push: PushLineageRow = {
        id: 1,
        branchId: input.branch.branchId,
        documentId: input.branch.documentId,
        pushKind: input.pushKind,
        journalIds: input.journalRows.map((row: BranchJournalRow) => row.id),
        upstreamUpdateSeq: 1,
        receiptPayload: input.receiptPayload,
        idempotencyKey: input.idempotencyKey,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      };
      await persistDurableTrailRecord(input.trail, push, { record });
      return { status: "inserted" as const, push };
    });
    await harness
      .service({ record, reopenOwners: vi.fn() })
      .pushToLive({ branchId: harness.branch.branchId });

    const trails = record.mock.calls[0]?.[0].trails;
    expect(trails).toHaveLength(2);
    expect(
      trails.map((trail: { owner: { turnId: string }; changes: unknown[] }) => [
        trail.owner.turnId,
        trail.changes.length,
      ]),
    ).toEqual([
      [TURN_ID, 1],
      [secondTurnId, 1],
    ]);
  });
  it("attributes one repeatedly edited block to every owning turn", async () => {
    const harness = new Harness();
    await harness.init();
    const secondTurnId = "00000000-0000-4000-8000-000000000006" as TurnId;
    const editedDoc = cloneDoc(harness.liveDoc);
    const block = model.getBlocks(toDocHandle(editedDoc))[0];
    if (!block) throw new Error("missing block");
    const before = Y.encodeStateVector(editedDoc);
    model.applyTextEdit(toDocHandle(editedDoc), block, { from: 0, to: 0 }, "First ");
    const firstUpdate = Y.encodeStateAsUpdate(editedDoc, before);
    const between = Y.encodeStateVector(editedDoc);
    model.applyTextEdit(toDocHandle(editedDoc), block, { from: 0, to: 0 }, "Second ");
    const secondUpdate = Y.encodeStateAsUpdate(editedDoc, between);
    harness.branch.state = Y.encodeStateAsUpdate(editedDoc);
    harness.branch.stateVector = Y.encodeStateVector(editedDoc);
    const rows = [
      { ...harness.row, updateData: firstUpdate },
      { ...harness.row, id: 2, turnId: secondTurnId, updateData: secondUpdate },
    ];
    harness.pushStore.listActiveJournalRows = vi.fn(async () => rows);
    const record = vi.fn();
    harness.pushStore.commitPush = vi.fn(async (input) => {
      const push = {
        id: 1,
        branchId: input.branch.branchId,
        documentId: input.branch.documentId,
        pushKind: input.pushKind,
        journalIds: rows.map((row) => row.id),
        upstreamUpdateSeq: 1,
        receiptPayload: input.receiptPayload,
        idempotencyKey: input.idempotencyKey,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      } satisfies PushLineageRow;
      await persistDurableTrailRecord(input.trail, push, { record });
      return { status: "inserted" as const, push };
    });
    await harness
      .service({ record, reopenOwners: vi.fn() })
      .pushToLive({ branchId: harness.branch.branchId });

    expect(
      record.mock.calls[0]?.[0].trails.map(
        (trail: { owner: { turnId: string } }) => trail.owner.turnId,
      ),
    ).toEqual([TURN_ID, secondTurnId]);
  });

  it("records a selective push through the atomic store callback", async () => {
    const harness = new Harness();
    await harness.init();
    const record = vi.fn();
    harness.pushStore.commitPush = vi.fn(async (input) => {
      const push = {
        id: 1,
        branchId: input.branch.branchId,
        documentId: input.branch.documentId,
        pushKind: input.pushKind,
        journalIds: [harness.row.id],
        upstreamUpdateSeq: 1,
        receiptPayload: input.receiptPayload,
        idempotencyKey: input.idempotencyKey,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      } satisfies PushLineageRow;
      await persistDurableTrailRecord(input.trail, push, { record });
      return { status: "inserted" as const, push };
    });
    await harness.service({ record, reopenOwners: vi.fn() }).pushSelectedToLive({
      branchId: harness.branch.branchId,
      journalIds: [harness.row.id],
    });

    expect(record).toHaveBeenCalledOnce();
  });
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

  it("does not commit when the live lock cannot be acquired", async () => {
    const harness = new Harness();
    await harness.init();
    harness.failApply = true;

    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).rejects.toThrow("apply failed");

    expect(harness.pushStore.commitPush).not.toHaveBeenCalled();
    expect(harness.row.status).toBe("active");
    expect(harness.lineage).toHaveLength(0);
    expect(markdown(harness.liveDoc)).not.toContain("Draft words here.");
  });

  it("leaves the durable push recoverable when applying it to the live doc fails", async () => {
    const harness = new Harness();
    await harness.init();
    const failApply = () => {
      throw new Error("phase 3 apply failed");
    };
    harness.liveDoc.on("update", failApply);

    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).rejects.toThrow("phase 3 apply failed");

    const recovered = docFromUpdate(
      Y.mergeUpdates((await harness.journal.read(DOCUMENT_ID)).updates.map((row) => row.update)),
    );
    expect(markdown(recovered)).toContain("Draft words here.");
    expect(harness.row.status).toBe("pushed");
    expect(harness.lineage).toHaveLength(1);

    harness.liveDoc.off("update", failApply);
    await expect(
      harness.service().pushToLive({ branchId: harness.branch.branchId }),
    ).resolves.toMatchObject({ status: "already_pushed", push: harness.lineage[0] });
    recovered.destroy();
  });

  it.each([
    { origin: "human:user-2", pushKind: "whole", expected: "push_concurrent_conflict" },
    { origin: "human:user-2", pushKind: "selected", expected: "push_concurrent_conflict" },
    { origin: "human:user-2", pushKind: "auto", expected: "pushed" },
    { origin: "agent:other-turn", pushKind: "whole", expected: "pushed" },
  ])("gates $pushKind destructive pushes on pre-existing $origin edits", async ({
    origin,
    pushKind,
    expected,
  }) => {
    const liveDoc = docFromMarkdown("Doomed paragraph.\n\nSurvivor paragraph.");
    const branchDoc = cloneDoc(liveDoc);
    const doomed = model.getBlocks(toDocHandle(branchDoc))[0];
    if (!doomed) throw new Error("missing doomed block");
    const beforeDelete = Y.encodeStateVector(branchDoc);
    model.deleteBlock(toDocHandle(branchDoc), doomed);
    const deleteUpdate = Y.encodeStateAsUpdate(branchDoc, beforeDelete);
    const branch = makeBranch(branchDoc);
    const row: BranchJournalRow = {
      id: 1,
      branchId: branch.branchId,
      generation: branch.generation,
      wId: 1,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData: deleteUpdate,
      draftBaseUpdateSeq: 1,
      status: "active",
    };
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), { origin: "system", seq: 0 });
    const commitPush = vi.fn(async (prepared) => {
      const result = {
        status: "inserted" as const,
        push: {
          id: 1,
          branchId: branch.branchId,
          documentId: DOCUMENT_ID,
          pushKind: "whole" as const,
          journalIds: [row.id],
          upstreamUpdateSeq: 2,
          receiptPayload: prepared.receiptPayload,
          idempotencyKey: prepared.idempotencyKey,
          threadId: row.threadId,
          turnId: row.turnId,
        },
      };
      await persistDurableTrailRecord(
        prepared.trail,
        result.push,
        { record: async () => {} },
        notices,
      );
      row.status = "pushed";
      return result;
    });
    const before = Y.encodeStateVector(liveDoc);
    const liveDoomed = model.getBlocks(toDocHandle(liveDoc))[0];
    if (!liveDoomed) throw new Error("missing live doomed block");
    model.applyTextEdit(
      toDocHandle(liveDoc),
      liveDoomed,
      { from: 0, to: model.getText(liveDoomed).length },
      "Edited since this draft was written.",
    );
    const durableHumanSeq = await journal.append(
      DOCUMENT_ID,
      Y.encodeStateAsUpdate(liveDoc, before),
      {
        origin,
        ...(origin.startsWith("agent:") ? { actorTurnId: "other-turn" } : {}),
        seq: 0,
      },
    );
    // The pull reaches the branch after the delete was authored; delete-wins
    // hides the inserted text there, which is exactly the destructive case.
    Y.applyUpdate(branchDoc, Y.encodeStateAsUpdate(liveDoc));
    branch.state = Y.encodeStateAsUpdate(branchDoc);
    branch.stateVector = Y.encodeStateVector(branchDoc);
    if (pushKind === "auto") branch.pushPolicy = "auto";
    const notices = {
      record: vi.fn(async () => {}),
      drainForModelContext: vi.fn(async () => []),
      drainForWriter: vi.fn(async () => []),
      subscribeWriterVisible: vi.fn(() => () => {}),
    } satisfies NoticePort;
    const service = createBranchPushService({
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: vi.fn(async () => branch),
        updateBranchSnapshot: vi.fn(),
      },
      pushStore: {
        listActiveJournalRows: vi.fn(async () => (row.status === "active" ? [row] : [])),
        listConcurrentJournalRows: vi.fn(async () => []),
        latestPushForBranch: vi.fn(async () => null),
        commitPush,
        countUnpushedRowsForWork: vi.fn(async () => (row.status === "active" ? 1 : 0)),
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [branch.branchId]),
        updateWorkDraftPushPolicy: vi.fn(),
        markRollbackPending: vi.fn(async () => 0),
      },
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (_documentId, fn) => fn(liveDoc)),
        recover: vi.fn(),
      },
      model,
      codec,
      notices,
      resolveDocumentTitle: async () => "The Ninefold Furnace",
    });

    const result =
      pushKind === "selected"
        ? await service.pushSelectedToLive({ branchId: branch.branchId, journalIds: [row.id] })
        : pushKind === "auto"
          ? await service.pushAutoBranchAfterThreadPeerWrite({
              workDraftBranchId: branch.branchId,
            })
          : await service.pushToLive({
              branchId: branch.branchId,
            });

    expect(result.status).toBe(expected);
    if (expected === "push_concurrent_conflict") {
      expect(result).toMatchObject({ status: "push_concurrent_conflict" });
      expect(result.status === "push_concurrent_conflict" && result.conflictedBlocks).toHaveLength(
        1,
      );
      expect(commitPush).not.toHaveBeenCalled();
      expect(row.status).toBe("active");
      expect(markdown(liveDoc)).toContain("Edited since this draft was written.");
      const durable = await journal.read(DOCUMENT_ID);
      expect(durable.updates.map((update) => update.meta.origin)).toEqual(["system", origin]);
    } else {
      expect(commitPush).toHaveBeenCalledOnce();
      expect(row.status).toBe("pushed");
      if (pushKind === "auto") {
        expect(result).toMatchObject({
          status: "pushed",
          swept: {
            capturedDeletedBodies: [
              { hash: expect.any(String), body: expect.stringContaining("Edited since") },
            ],
            beforeContentRef: durableHumanSeq,
          },
        });
        expect(markdown(liveDoc)).not.toContain("Edited since this draft was written.");
        expect(notices.record).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "push_swept",
            writerVisible: true,
            data: expect.objectContaining({
              documentName: "The Ninefold Furnace",
              threadId: THREAD_ID,
              turnId: TURN_ID,
            }),
          }),
        );
      }
    }
    branchDoc.destroy();
    liveDoc.destroy();
  });

  it.each([
    "whole",
    "selected",
    "manifest",
  ] as const)("durably settles the %s push late window before applying", async (path) => {
    const liveDoc = docFromMarkdown("Doomed paragraph.\n\nSurvivor paragraph.");
    const branchDoc = cloneDoc(liveDoc);
    const doomed = model.getBlocks(toDocHandle(branchDoc))[0];
    if (!doomed) throw new Error("missing doomed block");
    const deletedHash = model.getDocumentBlockIds(toDocHandle(branchDoc))[0];
    const beforeDelete = Y.encodeStateVector(branchDoc);
    model.deleteBlock(toDocHandle(branchDoc), doomed);
    const branch = makeBranch(branchDoc);
    const manifestBranch = { ...makeBranch(liveDoc), branchId: "branch_manifest" };
    const row: BranchJournalRow = {
      id: 1,
      branchId: branch.branchId,
      generation: 1,
      wId: 1,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(branchDoc, beforeDelete),
      draftBaseUpdateSeq: 1,
      status: "active",
    };
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), {
      origin: "system",
      seq: 0,
    });
    const notices = {
      record: vi.fn(async () => {}),
      drainForModelContext: vi.fn(async () => []),
      drainForWriter: vi.fn(async () => []),
      subscribeWriterVisible: vi.fn(() => () => {}),
    } satisfies NoticePort;
    const settlements: DurableTrailRecord[] = [];
    let durableSettlement: PendingLiveSettlement | null = null;
    const commitPush = vi.fn(async (prepared) => {
      const push = {
        id: 1,
        branchId: branch.branchId,
        documentId: DOCUMENT_ID,
        pushKind: "whole" as const,
        journalIds: [1],
        upstreamUpdateSeq: 2,
        receiptPayload: prepared.receiptPayload,
        idempotencyKey: prepared.idempotencyKey,
      };
      durableSettlement = { ...prepared.pendingLiveSettlement, push };
      return {
        status: "inserted" as const,
        push,
        settlement: durableSettlement as PendingLiveSettlement,
      };
    });
    const service = createBranchPushService({
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: vi.fn(async (id) => (id === branch.branchId ? branch : manifestBranch)),
        updateBranchSnapshot: vi.fn(),
      },
      pushStore: {
        listActiveJournalRows: vi.fn(async (id) => (id === branch.branchId ? [row] : [])),
        listConcurrentJournalRows: vi.fn(async () => []),
        latestPushForBranch: vi.fn(async () => null),
        commitPush,
        loadLiveSettlement: vi.fn(async () => {
          if (!durableSettlement) throw new Error("missing durable settlement");
          return withDurableWriterProvenance(durableSettlement);
        }),
        settlePushTrail: vi.fn(async ({ trail }) => {
          // This is the durable aggregate/outbox boundary. The live delete must
          // not have happened yet when settlement commits.
          expect(markdown(liveDoc)).toContain("Unjournaled WS body.");
          settlements.push(trail);
          return true;
        }),
        commitPushBatch: vi.fn(),
        countUnpushedRowsForWork: vi.fn(async () => 1),
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [branch.branchId]),
        updateWorkDraftPushPolicy: vi.fn(),
        markRollbackPending: vi.fn(async () => 0),
      },
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (_documentId, fn) => fn(liveDoc)),
        recover: vi.fn(),
      },
      model,
      codec,
      notices,
      hooks: {
        afterDurableCommit: async () => {
          const beforeWriter = Y.encodeStateVector(liveDoc);
          const liveDoomed = model.getBlocks(toDocHandle(liveDoc))[0];
          if (!liveDoomed) throw new Error("missing live doomed block");
          model.applyTextEdit(
            toDocHandle(liveDoc),
            liveDoomed,
            { from: 0, to: model.getText(liveDoomed).length },
            "Unjournaled WS body.",
          );
          if (!durableSettlement) throw new Error("missing durable settlement");
          durableSettlement = {
            ...durableSettlement,
            postCutUpdates: [Y.encodeStateAsUpdate(liveDoc, beforeWriter)],
          };
        },
      },
    });

    const result =
      path === "whole"
        ? await service.pushToLive({ branchId: branch.branchId })
        : path === "selected"
          ? await service.pushSelectedToLive({ branchId: branch.branchId, journalIds: [row.id] })
          : await service.pushToLiveWithManifestEntry({
              branchId: branch.branchId,
              manifestBranchId: manifestBranch.branchId,
              manifestEntryDocumentId: DOCUMENT_ID,
            });

    expect(result.status).toBe("pushed");
    expect(markdown(liveDoc)).not.toContain("Unjournaled WS body.");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject(
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            beforeBlockIdentity: expect.objectContaining({ documentId: DOCUMENT_ID }),
            swept: expect.objectContaining({
              affectedBlockHash: deletedHash,
              affectedBlockIdentity: expect.objectContaining({ documentId: DOCUMENT_ID }),
              removed: expect.objectContaining({ markdown: "Unjournaled WS body." }),
            }),
          }),
        ],
        transactionalNotice: expect.objectContaining({
          kind: "push_swept",
          data: expect.objectContaining({
            affectedBlockHashes: [deletedHash],
            capturedDeletedBodies: [
              expect.objectContaining({
                hash: deletedHash,
                body: "Unjournaled WS body.",
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("joins a late writer edit by canonical identity when its display hash widens", async () => {
    const { liveDoc, collisionUpdate, initialTargetHash } = prefixWideningFixture();
    appendParagraph(liveDoc, "Survivor paragraph.");
    const branchDoc = cloneDoc(liveDoc);
    const doomed = model.getBlocks(toDocHandle(branchDoc))[0];
    if (!doomed) throw new Error("missing doomed collision target");
    const beforeDelete = Y.encodeStateVector(branchDoc);
    model.deleteBlock(toDocHandle(branchDoc), doomed);
    const branch = makeBranch(branchDoc);
    const row: BranchJournalRow = {
      id: 1,
      branchId: branch.branchId,
      generation: 1,
      wId: 1,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(branchDoc, beforeDelete),
      draftBaseUpdateSeq: 1,
      status: "active",
    };
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), {
      origin: "system",
      seq: 0,
    });
    const settlements: DurableTrailRecord[] = [];
    let durableSettlement: PendingLiveSettlement | null = null;
    const service = createBranchPushService({
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: vi.fn(async () => branch),
        updateBranchSnapshot: vi.fn(),
      },
      pushStore: {
        listActiveJournalRows: vi.fn(async () => [row]),
        listConcurrentJournalRows: vi.fn(async () => []),
        latestPushForBranch: vi.fn(async () => null),
        commitPush: vi.fn(async (prepared) => {
          const push = {
            id: 1,
            branchId: branch.branchId,
            documentId: DOCUMENT_ID,
            pushKind: "whole" as const,
            journalIds: [row.id],
            upstreamUpdateSeq: 2,
            receiptPayload: prepared.receiptPayload,
            idempotencyKey: prepared.idempotencyKey,
          };
          durableSettlement = { ...prepared.pendingLiveSettlement, push };
          return {
            status: "inserted" as const,
            push,
            settlement: durableSettlement as PendingLiveSettlement,
          };
        }),
        loadLiveSettlement: vi.fn(async () => {
          if (!durableSettlement) throw new Error("missing durable settlement");
          return withDurableWriterProvenance(durableSettlement);
        }),
        settlePushTrail: vi.fn(async ({ trail }) => {
          settlements.push(trail);
          return true;
        }),
        countUnpushedRowsForWork: vi.fn(async () => 1),
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [branch.branchId]),
        updateWorkDraftPushPolicy: vi.fn(),
        markRollbackPending: vi.fn(async () => 0),
      },
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (_documentId, fn) => fn(liveDoc)),
        recover: vi.fn(),
      },
      model,
      codec,
      hooks: {
        afterDurableCommit: async () => {
          const beforeWriter = Y.encodeStateVector(liveDoc);
          const liveDoomed = model.getBlocks(toDocHandle(liveDoc))[0];
          if (!liveDoomed) throw new Error("missing live collision target");
          model.applyTextEdit(
            toDocHandle(liveDoc),
            liveDoomed,
            { from: 0, to: model.getText(liveDoomed).length },
            "Writer body behind widened hash.",
          );
          Y.applyUpdate(liveDoc, collisionUpdate);
          expect(model.getBlockId(liveDoomed)).not.toBe(initialTargetHash);
          if (!durableSettlement) throw new Error("missing durable settlement");
          durableSettlement = {
            ...durableSettlement,
            postCutUpdates: [Y.encodeStateAsUpdate(liveDoc, beforeWriter)],
          };
        },
      },
    });

    await expect(service.pushToLive({ branchId: branch.branchId })).resolves.toMatchObject({
      status: "pushed",
      swept: expect.objectContaining({
        capturedDeletedBodies: [
          expect.objectContaining({ body: "Writer body behind widened hash." }),
        ],
      }),
    });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.changes[0]).toMatchObject({
      beforeBlockIdentity: expect.objectContaining({ documentId: DOCUMENT_ID }),
      writerProtection: expect.objectContaining({
        body: expect.objectContaining({ markdown: "Writer body behind widened hash." }),
      }),
    });
  });

  it("cold-recovers a durably captured writer cut after the push was journaled", async () => {
    const liveDoc = docFromMarkdown("Doomed paragraph.\n\nSurvivor paragraph.");
    const branchDoc = cloneDoc(liveDoc);
    const doomed = model.getBlocks(toDocHandle(branchDoc))[0];
    if (!doomed) throw new Error("missing doomed block");
    const beforeDelete = Y.encodeStateVector(branchDoc);
    model.deleteBlock(toDocHandle(branchDoc), doomed);
    const branch = makeBranch(branchDoc);
    const row: BranchJournalRow = {
      id: 1,
      branchId: branch.branchId,
      generation: 1,
      wId: 1,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(branchDoc, beforeDelete),
      draftBaseUpdateSeq: 1,
      status: "active",
    };
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), {
      origin: "system",
      seq: 0,
    });
    let pending: import("./branch-push.js").PendingLiveSettlement | null = null;
    const settlements: DurableTrailRecord[] = [];
    const completed: number[] = [];
    let activeDoc = liveDoc;
    const pushStore: BranchPushStore = {
      listActiveJournalRows: vi.fn(async () => [row]),
      listConcurrentJournalRows: vi.fn(async () => []),
      latestPushForBranch: vi.fn(async () => null),
      commitPush: vi.fn(async (prepared) => {
        const push: PushLineageRow = {
          id: 1,
          branchId: branch.branchId,
          documentId: DOCUMENT_ID,
          pushKind: "whole",
          journalIds: [row.id],
          upstreamUpdateSeq: 2,
          receiptPayload: prepared.receiptPayload,
          idempotencyKey: prepared.idempotencyKey,
        };
        pending = { ...prepared.pendingLiveSettlement, push };
        return { status: "inserted" as const, push };
      }),
      settlePushTrail: vi.fn(async ({ trail }) => {
        settlements.push(trail);
        return true;
      }),
      listRecoverableSettlementIds: vi.fn(async () => (pending ? [pending.push.id] : [])),
      claimRecoverable: vi.fn(async () => (pending ? withDurableWriterProvenance(pending) : null)),
      withCompletionFence: vi.fn(async ({ pushId }, complete) => {
        const result = complete();
        if (result !== "retry") {
          completed.push(pushId);
          pending = null;
        }
        return result;
      }),
      countUnpushedRowsForWork: vi.fn(async () => 1),
      listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [branch.branchId]),
      updateWorkDraftPushPolicy: vi.fn(),
      markRollbackPending: vi.fn(async () => 0),
    };
    const service = createBranchPushService({
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: vi.fn(async () => branch),
        updateBranchSnapshot: vi.fn(),
      },
      pushStore,
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (_documentId, fn) => fn(activeDoc)),
        recover: vi.fn(),
      },
      model,
      codec,
      hooks: {
        afterDurableCommit: async () => {
          const beforeWriter = Y.encodeStateVector(liveDoc);
          const liveDoomed = model.getBlocks(toDocHandle(liveDoc))[0];
          if (!liveDoomed) throw new Error("missing live doomed block");
          model.applyTextEdit(
            toDocHandle(liveDoc),
            liveDoomed,
            { from: 0, to: model.getText(liveDoomed).length },
            "Writer body in crash window.",
          );
          const writerUpdate = Y.encodeStateAsUpdate(liveDoc, beforeWriter);
          if (!pending) throw new Error("push did not create settlement state");
          pending = { ...pending, postCutUpdates: [writerUpdate] };
          throw new Error("injected process crash");
        },
      },
    });

    await expect(service.pushToLive({ branchId: branch.branchId })).rejects.toThrow(
      "injected process crash",
    );
    const durable = pending as unknown as import("./branch-push.js").PendingLiveSettlement;
    const coldDoc = createCollabYDoc({ gc: false });
    Y.applyUpdate(coldDoc, durable.lockCutUpdate);
    Y.applyUpdate(coldDoc, durable.pushUpdate);
    for (const writerUpdate of durable.postCutUpdates) Y.applyUpdate(coldDoc, writerUpdate);
    activeDoc = coldDoc;
    expect(markdown(coldDoc)).not.toContain("Writer body in crash window.");
    await expect(service.recoverPendingLiveSettlements()).resolves.toBe(1);
    expect(markdown(coldDoc)).not.toContain("Writer body in crash window.");
    expect(settlements.at(-1)?.changes[0]).toMatchObject({
      writerProtection: expect.objectContaining({
        body: expect.objectContaining({ markdown: "Writer body in crash window." }),
      }),
    });
    expect(completed).toEqual([1]);
  });

  it("allows a pulled human edit that the branch preserves outside its deletion", async () => {
    const liveDoc = docFromMarkdown("Doomed paragraph.\n\nWriter paragraph.");
    const branchDoc = cloneDoc(liveDoc);
    const doomed = model.getBlocks(toDocHandle(branchDoc))[0];
    if (!doomed) throw new Error("missing doomed block");
    const beforeDelete = Y.encodeStateVector(branchDoc);
    model.deleteBlock(toDocHandle(branchDoc), doomed);
    const row: BranchJournalRow = {
      id: 1,
      branchId: "branch_a",
      generation: 1,
      wId: 1,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData: Y.encodeStateAsUpdate(branchDoc, beforeDelete),
      draftBaseUpdateSeq: 1,
      status: "active",
    };
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), {
      origin: "system",
      seq: 0,
    });
    const beforeHuman = Y.encodeStateVector(liveDoc);
    const survivor = model.getBlocks(toDocHandle(liveDoc))[1];
    if (!survivor) throw new Error("missing survivor block");
    model.applyTextEdit(toDocHandle(liveDoc), survivor, { from: 0, to: 0 }, "Preserved ");
    const humanUpdate = Y.encodeStateAsUpdate(liveDoc, beforeHuman);
    await journal.append(DOCUMENT_ID, humanUpdate, { origin: "human:user-2", seq: 0 });
    Y.applyUpdate(branchDoc, humanUpdate);
    const branch = makeBranch(branchDoc);
    const commitPush = vi.fn(async (prepared) => ({
      status: "inserted" as const,
      push: {
        id: 1,
        branchId: branch.branchId,
        documentId: DOCUMENT_ID,
        pushKind: "whole" as const,
        journalIds: [row.id],
        upstreamUpdateSeq: 3,
        receiptPayload: prepared.receiptPayload,
        idempotencyKey: prepared.idempotencyKey,
      },
    }));
    const service = createBranchPushService({
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: vi.fn(async () => branch),
        updateBranchSnapshot: vi.fn(),
      },
      pushStore: {
        listActiveJournalRows: vi.fn(async () => [row]),
        listConcurrentJournalRows: vi.fn(async () => []),
        latestPushForBranch: vi.fn(async () => null),
        commitPush,
        countUnpushedRowsForWork: vi.fn(async () => 1),
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [branch.branchId]),
        updateWorkDraftPushPolicy: vi.fn(),
        markRollbackPending: vi.fn(async () => 0),
      },
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (_documentId, fn) => fn(liveDoc)),
        recover: vi.fn(),
      },
      model,
      codec,
    });

    await expect(service.pushToLive({ branchId: branch.branchId })).resolves.toMatchObject({
      status: "pushed",
    });
    expect(commitPush).toHaveBeenCalledOnce();
    expect(markdown(liveDoc)).toContain("Preserved Writer paragraph.");
    branchDoc.destroy();
    liveDoc.destroy();
  });

  it("rejects a multi-document push atomically when one document conflicts", async () => {
    const manifestId = "00000000-0000-4000-8000-000000000009" as DocumentId;
    const contentLive = docFromMarkdown("Content doomed.\n\nContent survivor.");
    const manifestLive = docFromMarkdown("Manifest doomed.\n\nManifest survivor.");
    const makeDeletingBranch = (
      live: Y.Doc,
      branchId: string,
      documentId: DocumentId,
    ): { branch: BranchSnapshot; update: Uint8Array } => {
      const doc = cloneDoc(live);
      const doomed = model.getBlocks(toDocHandle(doc))[0];
      if (!doomed) throw new Error("missing batch doomed block");
      const before = Y.encodeStateVector(doc);
      model.deleteBlock(toDocHandle(doc), doomed);
      return {
        branch: { ...makeBranch(doc), branchId, documentId },
        update: Y.encodeStateAsUpdate(doc, before),
      };
    };
    const content = makeDeletingBranch(contentLive, "branch-content", DOCUMENT_ID);
    const manifest = makeDeletingBranch(manifestLive, "branch-manifest", manifestId);
    const rows: BranchJournalRow[] = [
      {
        id: 1,
        branchId: content.branch.branchId,
        generation: 1,
        wId: 1,
        source: "agent",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actorUserId: null,
        updateData: content.update,
        draftBaseUpdateSeq: 1,
        status: "active",
      },
      {
        id: 2,
        branchId: manifest.branch.branchId,
        generation: 1,
        wId: 2,
        source: "agent",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actorUserId: null,
        updateData: manifest.update,
        draftBaseUpdateSeq: 1,
        updateMeta: { kind: "manifest_membership", documentId: DOCUMENT_ID },
        status: "active",
      },
    ];
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(contentLive), {
      origin: "system",
      seq: 0,
    });
    await journal.append(manifestId, Y.encodeStateAsUpdate(manifestLive), {
      origin: "system",
      seq: 0,
    });
    const beforeHuman = Y.encodeStateVector(manifestLive);
    const doomed = model.getBlocks(toDocHandle(manifestLive))[0];
    if (!doomed) throw new Error("missing manifest doomed block");
    model.applyTextEdit(toDocHandle(manifestLive), doomed, { from: 0, to: 0 }, "Writer: ");
    const humanUpdate = Y.encodeStateAsUpdate(manifestLive, beforeHuman);
    await journal.append(manifestId, humanUpdate, {
      origin: "human:user-2",
      seq: 0,
    });
    const manifestBranchDoc = docFromUpdate(manifest.branch.state);
    Y.applyUpdate(manifestBranchDoc, humanUpdate);
    manifest.branch.state = Y.encodeStateAsUpdate(manifestBranchDoc);
    manifest.branch.stateVector = Y.encodeStateVector(manifestBranchDoc);
    manifestBranchDoc.destroy();
    const commitPushBatch = vi.fn();
    const branchMutex = new KeyedMutex();
    const branchLock = vi.spyOn(branchMutex, "run");
    const docs = new Map<DocumentId, Y.Doc>([
      [DOCUMENT_ID, contentLive],
      [manifestId, manifestLive],
    ]);
    const service = createBranchPushService({
      criticalSections: createBranchCriticalSections(branchMutex),
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },

        getBranch: vi.fn(async (id) =>
          id === content.branch.branchId
            ? content.branch
            : id === manifest.branch.branchId
              ? manifest.branch
              : null,
        ),
        updateBranchSnapshot: vi.fn(),
      },
      pushStore: {
        listActiveJournalRows: vi.fn(async (branchId) =>
          rows.filter((row) => row.branchId === branchId && row.status === "active"),
        ),
        listConcurrentJournalRows: vi.fn(async () => []),
        latestPushForBranch: vi.fn(async () => null),
        commitPush: vi.fn(),
        commitPushBatch,
        countUnpushedRowsForWork: vi.fn(async () => 2),
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => rows.map((row) => row.branchId)),
        updateWorkDraftPushPolicy: vi.fn(),
        markRollbackPending: vi.fn(async () => 0),
      },
      journal,
      liveCoordinator: {
        withDocument: vi.fn(async (documentId, fn) => {
          const doc = docs.get(documentId as DocumentId);
          if (!doc) throw new Error("missing batch live doc");
          return fn(doc);
        }),
        recover: vi.fn(),
      },
      model,
      codec,
    });

    const result = await service.pushToLiveWithManifestEntry({
      branchId: content.branch.branchId,
      manifestBranchId: manifest.branch.branchId,
      manifestEntryDocumentId: DOCUMENT_ID,
    });

    expect(result.status).toBe("push_concurrent_conflict");
    expect(commitPushBatch).not.toHaveBeenCalled();
    expect(rows.map((row) => row.status)).toEqual(["active", "active"]);
    expect((await journal.read(DOCUMENT_ID)).updates).toHaveLength(1);
    expect((await journal.read(manifestId)).updates.map((update) => update.meta.origin)).toEqual([
      "system",
      "human:user-2",
    ]);
    expect(markdown(contentLive)).toContain("Content doomed.");
    expect(markdown(manifestLive)).toContain("Writer: Manifest doomed.");
    expect(branchLock.mock.calls.map(([branchId]) => branchId)).toEqual([
      "branch-content",
      "branch-manifest",
    ]);
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
    expect(harness.branchCoordinator.resetFromDocIfUnchangedWithLease).not.toHaveBeenCalled();
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
    expect(harness.branchCoordinator.resetFromDocIfUnchangedWithLease).toHaveBeenCalled();
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

  it("retries turn undo when the branch generation CAS misses during discard", async () => {
    const harness = new Harness();
    await harness.init();
    let commitAttempts = 0;
    harness.pushStore.commitDiscard = vi.fn(async (input) => {
      commitAttempts += 1;
      if (commitAttempts === 1) {
        throw new BranchPushCommitConflictError(input.branch.branchId);
      }
      harness.row.status = "discarded";
      harness.branch.state = input.state;
      harness.branch.stateVector = input.stateVector;
    });

    await expect(
      harness.service().reverseBranchTurn({
        branchId: harness.branch.branchId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        reviewedByUserId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reversed", branchId: harness.branch.branchId, journalIds: [1] });
    expect(harness.pushStore.commitDiscard).toHaveBeenCalledTimes(2);
    expect(markdown(docFromUpdate(harness.branch.state)).trim()).toBe("Base.");
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
      draftBaseUpdateSeq: 1,
    };
    const rows = [first, second];
    harness.pushStore.listActiveJournalRows = vi.fn(async () => rows);
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) => rowsForTurn(rows, input));
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
      draftBaseUpdateSeq: 1,
      status: "active",
    };
    const second: BranchJournalRow = {
      ...harness.row,
      id: 2,
      wId: 2,
      turnId: "00000000-0000-4000-8000-000000000024" as TurnId,
      updateData: secondUpdate,
      draftBaseUpdateSeq: 1,
      status: "active" as const,
    };
    const rows = [first, second];
    harness.pushStore.listActiveJournalRows = vi.fn(async () =>
      rows.filter((row) => row.status === "active"),
    );
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) => rowsForTurn(rows, input));
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

  it("collapses redo of same-client multi-row turns into one active row", async () => {
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
    const afterFirstVector = Y.encodeStateVector(firstDoc);
    const secondBlock = model.getBlocks(toDocHandle(firstDoc))[1];
    if (!secondBlock) throw new Error("missing second block");
    model.applyTextEdit(toDocHandle(firstDoc), secondBlock, { from: 0, to: 4 }, "Beta redone");
    const secondUpdate = Y.encodeStateAsUpdate(firstDoc, afterFirstVector);
    const rowA: BranchJournalRow = {
      ...harness.row,
      id: 1,
      updateData: firstUpdate,
      draftBaseUpdateSeq: 1,
      status: "discarded",
    };
    const rowB: BranchJournalRow = {
      ...harness.row,
      id: 2,
      wId: 2,
      updateData: secondUpdate,
      draftBaseUpdateSeq: 1,
      status: "discarded",
    };
    const rows = [rowA, rowB];
    harness.branch.state = Y.encodeStateAsUpdate(harness.liveDoc);
    harness.branch.stateVector = Y.encodeStateVector(harness.liveDoc);
    harness.pushStore.listJournalRowsForTurn = vi.fn(async (input) => rowsForTurn(rows, input));
    harness.pushStore.listJournalRowsForBranch = vi.fn(async () => rows);
    harness.pushStore.listActiveJournalRows = vi.fn(async () =>
      rows.filter((row) => row.status === "active"),
    );
    harness.pushStore.commitTurnRedo = vi.fn(async (input) => {
      for (const row of input.journalRows) {
        row.status = "active";
        row.updateData = input.replacementUpdateData ?? row.updateData;
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
      journalIds: [1],
    });

    expect(rowA.status).toBe("active");
    expect(rowB.status).toBe("discarded");

    await harness.service().pushSelectedToLive({
      branchId: harness.branch.branchId,
      journalIds: [rowA.id],
    });
    const liveAfterCollapsedRedo = markdown(harness.liveDoc);
    expect(liveAfterCollapsedRedo).toContain("Alpha redone target.");
    expect(liveAfterCollapsedRedo).toContain("Beta redone target.");
    firstDoc.destroy();
  });

  it("fences branch redo to the current generation after a reset", async () => {
    const harness = new Harness();
    await harness.init();
    harness.row.status = "discarded";
    harness.branch.generation += 1;
    harness.branch.state = Y.encodeStateAsUpdate(harness.liveDoc);
    harness.branch.stateVector = Y.encodeStateVector(harness.liveDoc);
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
        draftBaseUpdateSeq: 1,
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
        draftBaseUpdateSeq: 1,
        status: "active",
      },
    ];
    const journal = createInMemoryJournal();
    await journal.append(DOCUMENT_ID, Y.encodeStateAsUpdate(liveDoc), { origin: "system", seq: 0 });
    const lineage: PushLineageRow[] = [];
    const service = createBranchPushService({
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
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
      draftBaseUpdateSeq: 1,
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
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
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
  it.each(
    [
      {
        operation: "inline replace",
        command: {
          command: "replace",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          find: "Base paragraph.",
          content: "Agent inline replacement.",
        },
        markerSurvives: true,
        pushStatus: "push_concurrent_conflict",
      },
      {
        operation: "multi-block delete",
        command: {
          command: "replace",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          find: "Base paragraph.\n\nSecond paragraph.",
          content: "",
        },
        markerSurvives: true,
        pushStatus: "push_concurrent_conflict",
      },
      {
        operation: "block-type change",
        command: {
          command: "replace",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          find: "Base paragraph.",
          content: "# Agent heading",
        },
        markerSurvives: true,
        pushStatus: "push_concurrent_conflict",
      },
      {
        operation: "full overwrite",
        command: {
          command: "create",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "Agent replacement.",
          overwrite: true,
        },
        markerSurvives: true,
        pushStatus: "push_concurrent_conflict",
      },
    ].flatMap((scenario) => [
      { ...scenario, path: "staged", responseId: `response-push-${scenario.operation}` },
      { ...scenario, path: "immediate", responseId: undefined },
    ]),
  )("$operation on the $path path keeps the intended identities through branch push", async ({
    command,
    markerSurvives,
    pushStatus,
    responseId,
  }) => {
    const harness = new ThreadPeerPushHarness(
      "manual",
      "Base paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    );
    const core = harness.createThreadPeerCore();
    const writeContext = {
      sessionId: `session-push-${responseId ?? "immediate"}-${command.command}`,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    };
    await core.write(
      { command: "read", file: "chapter.md", documentId: DOCUMENT_ID },
      writeContext,
    );
    const result = await core.write(command as Parameters<typeof core.write>[0], {
      ...writeContext,
      ...(responseId
        ? { responseId, createdDocument: command.command === "create" ? false : undefined }
        : {}),
    });
    expect(result.status).toBe("success");
    if (responseId) await core.commitResponse(responseId);
    expect(harness.rows).toHaveLength(1);

    const [liveFirst] = model.getBlocks(toDocHandle(harness.liveDoc));
    if (!liveFirst) throw new Error("missing live block for concurrent human edit");
    model.applyTextEdit(
      toDocHandle(harness.liveDoc),
      liveFirst,
      { from: 0, to: 0 },
      "[HUMAN-PUSH]",
    );

    const pushed = await harness.branchPush.pushToLive({ branchId: harness.work.branchId });
    expect(pushed.status).toBe(pushStatus);

    const visible = markdown(harness.liveDoc);
    if (markerSurvives) expect(visible).toContain("[HUMAN-PUSH]");
    else expect(visible).not.toContain("[HUMAN-PUSH]");
  });

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
        draftBaseUpdateSeq: 1,
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
        draftBaseUpdateSeq: 1,
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

  it("attributes live agent reversal residue as agent while journal origin stays system", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const baselineSeq = (await harness.journal.read(DOCUMENT_ID)).updates.at(-1)?.seq ?? 0;
    const upstream = docFromUpdate(harness.work.state);
    const beforeVector = Y.encodeStateVector(upstream);
    appendParagraph(upstream, "Agent reversal residue.");
    const reversalUpdate = Y.encodeStateAsUpdate(upstream, beforeVector);
    await harness.journal.append(DOCUMENT_ID, reversalUpdate, {
      origin: "system",
      reversalActor: { type: "agent" },
      seq: 0,
    });
    harness.work.state = Y.encodeStateAsUpdate(upstream);

    const baselineDoc = docFromUpdate(harness.thread.state);
    const updates = await harness.createAgentCoordinator().concurrentUpdatesSince?.({
      docId: DOCUMENT_ID,
      doc: docFromUpdate(harness.thread.state),
      baselineDoc,
      sinceStateVector: Y.encodeStateVector(baselineDoc),
      liveJournalSeq: baselineSeq,
    });

    expect(updates?.map((update) => update.origin)).toContainEqual({
      type: "agent",
      actorTurnId: "unknown-agent",
    });
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
        draftBaseUpdateSeq: 1,
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
        draftBaseUpdateSeq: 1,
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
      { type: "human", userId: "unknown" },
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

  it("keeps ambiguous causal attribution conservative after removing byte decoding", async () => {
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
      draftBaseUpdateSeq: 1,
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
      { type: "human", userId: "unknown" },
    ]);
    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(
      rendered.info?.runs
        .flatMap((run) => run.blocks)
        .some((line) => line.includes("B-AGENT-CAUSAL")),
    ).toBe(true);
    expect(rendered.info?.human).toHaveLength(1);
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
      draftBaseUpdateSeq: 1,
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
      { type: "human", userId: "unknown" },
    ]);
    const probe = docFromUpdate(harness.thread.state);
    const rendered = applyConcurrentUpdates(toDocHandle(probe), model, agentCodec, updates ?? []);
    expect(rendered.info?.runs.flatMap((run) => run.tombstones.map((item) => item.hash))).toContain(
      deletedHash,
    );
    expect(
      rendered.info?.runs
        .flatMap((run) => run.blocks)
        .some((line) => line.includes("Z foreign agent insert.")),
    ).toBe(true);
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
      draftBaseUpdateSeq: 1,
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
    expect(rendered.info?.runs.flatMap((run) => run.tombstones.map((item) => item.hash))).toContain(
      deletedHash,
    );
    expect(
      rendered.info?.runs
        .flatMap((run) => run.blocks)
        .some((line) => line.includes("E foreign agent")),
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
    expect(rendered.info?.runs.flatMap((run) => run.tombstones.map((item) => item.hash))).toContain(
      deletedHash,
    );
    expect(
      rendered.info?.runs
        .filter((run) => run.origin === "human" || run.origin === "mixed")
        .flatMap((run) => run.blocks)
        .some((line) => line.includes("W inserted.")),
    ).toBe(true);
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
      draftBaseUpdateSeq: 1,
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
    expect(rendered.info?.runs.flatMap((run) => run.tombstones.map((item) => item.hash))).toContain(
      deletedHash,
    );
    expect(
      rendered.info?.runs
        .flatMap((run) => run.blocks)
        .some((line) => line.includes("Z agent survivor.")),
    ).toBe(true);
    expect(
      rendered.info?.runs
        .filter((run) => run.origin === "human" || run.origin === "mixed")
        .flatMap((run) => run.blocks) ?? [],
    ).not.toContain(deletedHash);
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
    expect(rendered.info?.runs.flatMap((run) => run.tombstones.map((item) => item.hash))).toContain(
      deletedHash,
    );
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
    expect(rendered.info?.runs.flatMap((run) => run.tombstones.map((item) => item.hash))).toContain(
      deletedHash,
    );
    expect(
      rendered.info?.runs
        .filter((run) => run.origin === "human" || run.origin === "mixed")
        .flatMap((run) => run.blocks)
        .some((line) => line.includes("W ritual boilerplate rewritten.")),
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

    expect(updates?.map((update) => update.origin)).toEqual([{ type: "human", userId: "unknown" }]);
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
        draftBaseUpdateSeq: 1,
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
        draftBaseUpdateSeq: 1,
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
    const pending = createBranchPendingJournalEntries(createBranchAgentEditDiagnostics(eventSink));

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
        actorKind: "agent",
        mode: "threadPeer",
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
      draftBaseUpdateSeq: 1,
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
        actorKind: "agent",
        mode: "threadPeer",
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
        actorKind: "agent",
        mode: "threadPeer",
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
      draftBaseUpdateSeq: 1,
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
      draftBaseUpdateSeq: 1,
      status: "active",
    });
    harness.failNextCommitSync = true;
    const pending = createBranchPendingJournalEntries();
    const pushPending = (writeId: string) =>
      pending.push({
        docId: DOCUMENT_ID,
        update: new Uint8Array(),
        meta: { origin: `agent:${writeId}`, seq: 0 },
        mutation: {
          actorKind: "agent",
          mode: "threadPeer",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          wId: 1,
          writeId,
          branchGeneration: harness.work.generation,
        },
      });
    pushPending("attempt-failed");
    const coordinator = harness.createAgentCoordinator(pending);
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
    pushPending("attempt-success");
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

  it("rejects an in-flight thread-peer write after a no-change pull generation is reset", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const pending = createBranchPendingJournalEntries();
    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array(),
      meta: { origin: "agent:stale", seq: 0 },
      mutation: {
        actorKind: "agent",
        mode: "threadPeer",
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

  it("commits staged create, replace, and insert through the response path with generation fencing", async () => {
    const scenarios: Array<{
      label: string;
      command: Parameters<ReturnType<ThreadPeerPushHarness["createThreadPeerCore"]>["write"]>[0];
      seed?: string;
      expected: string;
    }> = [
      {
        label: "create",
        command: {
          command: "create",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "Created through staged response.",
          overwrite: true,
        },
        expected: "Created through staged response.",
      },
      {
        label: "replace",
        command: {
          command: "replace",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          find: "Base.",
          content: "Replaced through staged response.",
        },
        expected: "Replaced through staged response.",
      },
      {
        label: "insert",
        command: {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "Inserted through staged response.",
        },
        expected: "Inserted through staged response.",
      },
    ];

    for (const scenario of scenarios) {
      const harness = new ThreadPeerPushHarness("manual", scenario.seed ?? "Base.");
      const core = harness.createThreadPeerCore();
      const responseId = `response-staged-${scenario.label}`;

      const write = await core.write(scenario.command, {
        sessionId: `session-${scenario.label}`,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId,
        createdDocument: scenario.label === "create" ? false : undefined,
      });
      expect(write.status).toBe("success");
      expect(harness.rows).toHaveLength(0);
      expect(markdown(docFromUpdate(harness.work.state))).not.toContain(scenario.expected);

      await core.commitResponse(responseId);

      expect(harness.rows).toHaveLength(1);
      expect(harness.rows[0]).toEqual(
        expect.objectContaining({
          branchId: harness.work.branchId,
          generation: harness.work.generation,
          status: "active",
          turnId: TURN_ID,
        }),
      );
      expect(markdown(docFromUpdate(harness.work.state))).toContain(scenario.expected);
    }
  });

  it("commits two sequential staged responses in one thread runtime", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();

    await expect(
      core.write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "First staged response.",
        },
        {
          sessionId: "session-sequential",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-sequential-a",
        },
      ),
    ).resolves.toMatchObject({ status: "success" });
    await core.commitResponse("response-sequential-a");

    await expect(
      core.write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "Second staged response.",
        },
        {
          sessionId: "session-sequential",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-sequential-b",
        },
      ),
    ).resolves.toMatchObject({ status: "success" });
    await core.commitResponse("response-sequential-b");

    expect(harness.rows).toHaveLength(2);
    expect(harness.rows.map((row) => row.wId)).toEqual([1, 2]);
    expect(harness.rows.every((row) => row.status === "active")).toBe(true);
    expect(markdown(docFromUpdate(harness.work.state))).toContain("First staged response.");
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Second staged response.");
  });

  it("reverses a grouped draft response without touching older live writes", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const liveBefore = cloneDoc(harness.liveDoc);
    appendParagraph(harness.liveDoc, "Older live write.");
    const liveUpdate = Y.encodeStateAsUpdate(harness.liveDoc, Y.encodeStateVector(liveBefore));
    liveBefore.destroy();
    const liveOrdinal = await harness.journal.reserveWriteOrdinal(DOCUMENT_ID, THREAD_ID);
    await harness.journal.appendBatch([
      {
        docId: DOCUMENT_ID,
        update: liveUpdate,
        meta: { origin: `agent:${TURN_ID}`, actorTurnId: TURN_ID, seq: 0 },
        mutation: {
          mode: "live",
          actorKind: "agent",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          writeId: "older-live-write",
          wId: liveOrdinal,
        },
      },
    ]);
    harness.work.state = Y.encodeStateAsUpdate(harness.liveDoc);
    harness.work.stateVector = Y.encodeStateVector(harness.liveDoc);
    harness.thread.state = Y.encodeStateAsUpdate(harness.liveDoc);
    harness.thread.stateVector = Y.encodeStateVector(harness.liveDoc);
    const liveRowsBeforeDraft = (await harness.journal.read(DOCUMENT_ID)).updates.length;
    const core = harness.createThreadPeerCore();
    const responseId = "response-grouped-draft";
    const handles: string[] = [];

    for (let index = 0; index < 15; index += 1) {
      const write = await core.write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: `Draft write ${index + 1}.`,
        },
        {
          sessionId: "session-grouped-draft",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
          tool_use_id: `draft-tool-${index + 1}`,
        },
      );
      if (write.status !== "success" || !write.writeId) throw new Error("expected draft handle");
      handles.push(write.writeId);
    }
    await core.commitResponse(responseId);

    expect(new Set(handles)).toEqual(new Set(["w2"]));
    expect(harness.rows).toHaveLength(1);
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Draft write 15.");

    const undo = await core.write(
      { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID, all: true },
      {
        sessionId: "session-grouped-draft",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-grouped-draft-undo",
      },
    );

    expect(["reversed", "reconciled"]).toContain(undo.status);
    expect(markdown(docFromUpdate(harness.work.state))).not.toContain("Draft write 1.");
    expect(markdown(harness.liveDoc)).toContain("Older live write.");
    expect((await harness.journal.read(DOCUMENT_ID)).updates).toHaveLength(liveRowsBeforeDraft);
    expect(await harness.journal.latestActiveWrite(DOCUMENT_ID, THREAD_ID)).toMatchObject({
      handle: "w1",
    });

    const redo = await core.write(
      { command: "redo", file: "chapter.md", documentId: DOCUMENT_ID },
      {
        sessionId: "session-grouped-draft",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-grouped-draft-redo",
      },
    );

    expect(["reversed", "reconciled"]).toContain(redo.status);
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Draft write 15.");
    expect((await harness.journal.read(DOCUMENT_ID)).updates).toHaveLength(liveRowsBeforeDraft);
  });

  it("supports draft last, range, single-handle, and redo selectors before Apply", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Alpha.\n\nBeta.\n\nGamma.\n\nDelta.");
    const core = harness.createThreadPeerCore();
    const stageReplace = async (responseId: string, find: string, content: string) => {
      const write = await core.write(
        {
          command: "replace",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          find,
          content,
        },
        {
          sessionId: "session-draft-selectors",
          threadId: THREAD_ID,
          turnId: responseId,
          responseId,
        },
      );
      await core.commitResponse(responseId);
      return write;
    };
    const reversalContext = (responseId: string) => ({
      sessionId: "session-draft-selectors",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId,
    });

    await expect(stageReplace("response-selector-1", "Alpha.", "One.")).resolves.toMatchObject({
      writeId: "w1",
    });
    await expect(stageReplace("response-selector-2", "Beta.", "Two.")).resolves.toMatchObject({
      writeId: "w2",
    });
    await expect(stageReplace("response-selector-3", "Gamma.", "Three.")).resolves.toMatchObject({
      writeId: "w3",
    });

    await expect(
      core.write(
        { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID, last: 2 },
        reversalContext("response-selector-undo-last"),
      ),
    ).resolves.toMatchObject({ status: expect.stringMatching(/^(reversed|reconciled)$/) });
    expect(markdown(docFromUpdate(harness.work.state))).toBe("One.\n\nBeta.\n\nGamma.\n\nDelta.\n");

    await core.write(
      { command: "redo", file: "chapter.md", documentId: DOCUMENT_ID, all: true },
      reversalContext("response-selector-redo-last"),
    );
    expect(markdown(docFromUpdate(harness.work.state))).toBe("One.\n\nTwo.\n\nThree.\n\nDelta.\n");

    await core.write(
      {
        command: "undo",
        file: "chapter.md",
        documentId: DOCUMENT_ID,
        from: "w1",
        to: "w2",
      },
      reversalContext("response-selector-undo-range"),
    );
    expect(markdown(docFromUpdate(harness.work.state))).toBe(
      "Alpha.\n\nBeta.\n\nGamma.\n\nDelta.\n",
    );

    await core.write(
      { command: "redo", file: "chapter.md", documentId: DOCUMENT_ID, all: true },
      reversalContext("response-selector-redo-range"),
    );
    await expect(stageReplace("response-selector-4", "Delta.", "Four.")).resolves.toMatchObject({
      writeId: "w4",
    });
    await core.write(
      { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID, to: "w4" },
      reversalContext("response-selector-undo-single"),
    );

    expect(markdown(docFromUpdate(harness.work.state))).toBe("One.\n\nTwo.\n\nThree.\n\nDelta.\n");
    expect(markdown(harness.liveDoc)).toBe("Alpha.\n\nBeta.\n\nGamma.\n\nDelta.\n");
    expect((await harness.journal.read(DOCUMENT_ID)).updates).toHaveLength(1);
  });

  it("routes post-Apply undo to live authority and reverses the folded Apply group honestly", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();
    const stage = async (responseId: string, content: string) => {
      await core.write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content,
        },
        {
          sessionId: "session-post-apply",
          threadId: THREAD_ID,
          turnId: responseId,
          responseId,
        },
      );
      await core.commitResponse(responseId);
    };
    await stage("response-post-apply-1", "Applied first.");
    await stage("response-post-apply-2", "Applied second.");
    await harness.branchPush.pushToLive({ branchId: harness.work.branchId });

    const undo = await core.write(
      { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID },
      {
        sessionId: "session-post-apply",
        threadId: THREAD_ID,
        turnId: "turn-post-apply-undo",
        responseId: "response-post-apply-undo",
      },
    );

    expect(undo).toMatchObject({ status: expect.stringMatching(/^(reversed|reconciled)$/) });
    expect(undo.text).toContain("undo: 2 edit(s)");
    expect(markdown(harness.liveDoc)).toBe("Base.\n");
    const durable = new Y.Doc({ gc: false });
    const snapshot = await harness.journal.readForReconstruction(DOCUMENT_ID);
    if (snapshot.checkpoint) Y.applyUpdate(durable, snapshot.checkpoint);
    for (const update of snapshot.updates) Y.applyUpdate(durable, update.update);
    expect(markdown(durable)).toBe("Base.\n");
    durable.destroy();
    await expect(harness.journal.mutationsForWrite(DOCUMENT_ID, THREAD_ID, "w1")).resolves.toEqual([
      expect.objectContaining({ status: "reversed" }),
    ]);
    await expect(harness.journal.mutationsForWrite(DOCUMENT_ID, THREAD_ID, "w2")).resolves.toEqual([
      expect.objectContaining({ status: "reversed" }),
    ]);
  });

  it("leaves draft and live state unchanged when reversal persistence fails", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();
    await core.write(
      {
        command: "insert",
        file: "chapter.md",
        documentId: DOCUMENT_ID,
        content: "Draft content.",
      },
      {
        sessionId: "session-draft-failure",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-draft-failure-write",
      },
    );
    await core.commitResponse("response-draft-failure-write");
    const workBefore = markdown(docFromUpdate(harness.work.state));
    const branchRowsBefore = harness.rows.length;
    const liveRowsBefore = (await harness.journal.read(DOCUMENT_ID)).updates.length;
    vi.mocked(harness.branchCoordinator.commitSyncFromDoc).mockRejectedValueOnce(
      new Error("branch persistence unavailable"),
    );

    const failed = await core.write(
      { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID },
      {
        sessionId: "session-draft-failure",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-draft-failure-undo",
      },
    );

    expect(failed.status).toBe("internal_error");
    expect(markdown(docFromUpdate(harness.work.state))).toBe(workBefore);
    expect(harness.rows).toHaveLength(branchRowsBefore);
    expect((await harness.journal.read(DOCUMENT_ID)).updates).toHaveLength(liveRowsBefore);

    await expect(
      core.write(
        { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID },
        {
          sessionId: "session-draft-failure",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-draft-failure-retry",
        },
      ),
    ).resolves.toMatchObject({ status: expect.stringMatching(/^(reversed|reconciled)$/) });
  });

  it("rejects a staged reversal when branch history advances after planning", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();
    await core.write(
      {
        command: "insert",
        file: "chapter.md",
        documentId: DOCUMENT_ID,
        content: "Draft target.",
      },
      {
        sessionId: "session-draft-race",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-draft-race-write",
      },
    );
    await core.commitResponse("response-draft-race-write");
    vi.mocked(harness.branchCoordinator.commitSyncFromDoc).mockImplementationOnce(async (input) => {
      const before = docFromUpdate(harness.work.state);
      const concurrent = docFromUpdate(harness.work.state);
      appendParagraph(concurrent, "Concurrent branch row.");
      const updateData = Y.encodeStateAsUpdate(concurrent, Y.encodeStateVector(before));
      Y.applyUpdate(before, updateData);
      harness.work.state = Y.encodeStateAsUpdate(before);
      harness.work.stateVector = Y.encodeStateVector(before);
      harness.rows.push({
        id: harness.rows.length + 1,
        branchId: harness.work.branchId,
        generation: harness.work.generation,
        wId: null,
        source: "writer",
        threadId: null,
        turnId: null,
        actorUserId: USER_ID,
        updateData,
        draftBaseUpdateSeq: 1,
        status: "active",
      });
      before.destroy();
      concurrent.destroy();
      const expectedJournalWatermark = input.expectedJournalWatermark;
      if (
        expectedJournalWatermark === undefined ||
        !harness.rows.some((row) => row.id > expectedJournalWatermark)
      ) {
        throw new Error("reversal did not carry its branch journal watermark");
      }
      throw new Error("stale_branch_journal");
    });

    const undo = await core.write(
      { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID },
      {
        sessionId: "session-draft-race",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-draft-race-undo",
      },
    );

    expect(undo.status).toBe("internal_error");
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Draft target.");
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Concurrent branch row.");
    expect((await harness.journal.read(DOCUMENT_ID)).updates).toHaveLength(1);
  });

  it("rejects a staged reversal when Apply changes branch-row authority after planning", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();
    await core.write(
      {
        command: "insert",
        file: "chapter.md",
        documentId: DOCUMENT_ID,
        content: "Draft target.",
      },
      {
        sessionId: "session-draft-apply-race",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-draft-apply-race-write",
      },
    );
    await core.commitResponse("response-draft-apply-race-write");
    vi.mocked(harness.branchCoordinator.commitSyncFromDoc).mockImplementationOnce(async (input) => {
      const target = harness.rows.find((row) => row.wId === 1);
      if (!target) throw new Error("missing planned branch row");
      target.status = "pushed";
      if (
        input.expectedJournalRevision === undefined ||
        branchJournalRevision(harness.rows) === input.expectedJournalRevision
      ) {
        throw new Error("reversal did not carry its status-sensitive branch revision");
      }
      throw new Error("stale_branch_journal");
    });

    const undo = await core.write(
      { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID },
      {
        sessionId: "session-draft-apply-race",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-draft-apply-race-undo",
      },
    );

    expect(undo.status).toBe("internal_error");
    expect(markdown(docFromUpdate(harness.work.state))).toContain("Draft target.");
    expect((await harness.journal.read(DOCUMENT_ID)).updates).toHaveLength(1);
  });

  it("rejects reuse of a response id by a different thread core", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();
    const responseId = "response-owned-by-one-thread";
    const command = {
      command: "insert" as const,
      file: "chapter.md",
      documentId: DOCUMENT_ID,
      content: "Owned write.",
    };
    await core.write(command, {
      sessionId: "owner-session",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId,
    });

    await expect(
      core.write(command, {
        sessionId: "conflicting-session",
        threadId: "00000000-0000-4000-8000-000000000099",
        turnId: TURN_ID,
        responseId,
      }),
    ).rejects.toThrow("already owned by thread");

    const committed = await core.commitResponse(responseId);
    if (committed.status !== "committed") throw new Error("expected committed response");
    expect(committed.updateCount).toBe(1);
  });

  it("retains response ownership when commit aborts so its thread core remains retryable", async () => {
    const invalidated: Array<{ core: number; threadId: string }> = [];
    let nextCore = 0;
    const fakeCore = (): AgentEditCore => {
      const core = nextCore++;
      return {
        write: vi.fn(async () => ({ status: "success" })),
        commitResponse: vi.fn(async () => {
          throw new Error("durable projection and recovery failed");
        }),
        hasResponseDocument: vi.fn(() => false),
        withResponseDocument: vi.fn(async () => null),
        responseDocuments: vi.fn(() => ({ staged: [], created: [] })),
        getAvailability: vi.fn(async () => ({ undo: false, redo: false })),
        invalidateThread: vi.fn(async (_docId: string, threadId: string) => {
          invalidated.push({ core, threadId });
        }),
      } as unknown as AgentEditCore;
    };
    const threadB = "00000000-0000-4000-8000-000000000099" as ThreadId;
    const core = createThreadPeerAgentEditCore({
      commitThreadResponseAtomically: (operation) => operation(),
      liveUtilityCore: asLiveAgentEditCore(fakeCore()),
      createThreadCore: fakeCore,
      maxThreadCores: 1,
    });
    const responseId = "response-rejected-commit-owner";

    await core.write(
      { command: "read", file: "chapter.md", documentId: DOCUMENT_ID },
      { sessionId: "owner-session", threadId: THREAD_ID, turnId: TURN_ID, responseId },
    );
    await expect(core.commitResponse(responseId)).rejects.toThrow(
      "durable projection and recovery failed",
    );
    await core.getAvailability(DOCUMENT_ID, threadB);

    expect(invalidated).not.toContainEqual({ core: 1, threadId: THREAD_ID });
    expect(invalidated).toContainEqual({ core: 2, threadId: threadB });
  });

  it("routes hosted reversal through the live utility core", async () => {
    const liveReverse = vi.fn(async () => ({
      command: "undo" as const,
      status: "nothing_to_undo" as const,
      isError: false,
      text: "status: nothing_to_undo",
    }));
    const threadReverse = vi.fn(() => {
      throw new Error("thread reversal must not run");
    });
    const baseCore = (reverse: typeof liveReverse) =>
      ({
        reverse,
        invalidateThread: vi.fn(async () => undefined),
      }) as unknown as AgentEditCore;
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: asLiveAgentEditCore(baseCore(liveReverse)),
      createThreadCore: () => baseCore(threadReverse as typeof liveReverse),
      commitThreadResponseAtomically: (operation) => operation(),
    });

    await core.reverse({
      docId: DOCUMENT_ID,
      threadId: THREAD_ID,
      direction: "undo",
      selection: { kind: "latest" },
      actor: { type: "agent" },
    });

    expect(threadReverse).not.toHaveBeenCalled();
    expect(liveReverse).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: DOCUMENT_ID,
        actor: { type: "agent" },
      }),
    );
  });

  it("commits distinct responses that reuse a provider-local tool id", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();

    await expect(
      core.write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "First reused tool id.",
          tool_use_id: "call_mock_write_1",
        },
        {
          sessionId: "session-reused-provider-tool-id",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-reused-provider-tool-id-a",
        },
      ),
    ).resolves.toMatchObject({ status: "success", writeId: "w1" });
    await core.commitResponse("response-reused-provider-tool-id-a");

    await expect(
      core.write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "Second reused tool id.",
          tool_use_id: "call_mock_write_1",
        },
        {
          sessionId: "session-reused-provider-tool-id",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-reused-provider-tool-id-b",
        },
      ),
    ).resolves.toMatchObject({ status: "success", writeId: "w2" });
    await core.commitResponse("response-reused-provider-tool-id-b");

    expect(harness.rows).toHaveLength(2);
    expect(harness.rows.map((row) => row.wId)).toEqual([1, 2]);
    expect(harness.rows.every((row) => row.status === "active")).toBe(true);
    const workMarkdown = markdown(docFromUpdate(harness.work.state));
    expect(workMarkdown).toContain("First reused tool id.");
    expect(workMarkdown).toContain("Second reused tool id.");
  });

  it("commits a second staged response after discarding the first response", async () => {
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const core = harness.createThreadPeerCore();

    await core.write(
      {
        command: "insert",
        file: "chapter.md",
        documentId: DOCUMENT_ID,
        content: "Discarded staged response.",
      },
      {
        sessionId: "session-discard-then-write",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-before-discard",
      },
    );
    await core.commitResponse("response-before-discard");
    await harness.branchPush.discardSelected({
      branchId: harness.work.branchId,
      journalIds: [harness.rows[0]?.id ?? 0],
    });

    await expect(
      core.write(
        {
          command: "insert",
          file: "chapter.md",
          documentId: DOCUMENT_ID,
          content: "Second staged after discard.",
        },
        {
          sessionId: "session-discard-then-write",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-after-discard",
        },
      ),
    ).resolves.toMatchObject({ status: "success" });
    await core.commitResponse("response-after-discard");

    expect(harness.rows).toHaveLength(2);
    expect(harness.rows.map((row) => row.status)).toEqual(["discarded", "active"]);
    const workMarkdown = markdown(docFromUpdate(harness.work.state));
    expect(workMarkdown).not.toContain("Discarded staged response.");
    expect(workMarkdown).toContain("Second staged after discard.");

    await expect(
      core.write(
        { command: "undo", file: "chapter.md", documentId: DOCUMENT_ID },
        {
          sessionId: "session-discard-then-write",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId: "response-undo-after-discard",
        },
      ),
    ).resolves.toMatchObject({ status: expect.stringMatching(/^(reversed|reconciled)$/) });
    const workAfterUndo = markdown(docFromUpdate(harness.work.state));
    expect(workAfterUndo).not.toContain("Discarded staged response.");
    expect(workAfterUndo).not.toContain("Second staged after discard.");
    expect(markdown(harness.liveDoc)).toBe("Base.\n");
  });

  it("fails loudly when a staged response commit produces no branch journal row", async () => {
    const events = createInMemoryEventSink();
    const harness = new ThreadPeerPushHarness("manual", "Base.");
    const pending = createBranchPendingJournalEntries(createBranchAgentEditDiagnostics(events));
    pending.push({
      docId: DOCUMENT_ID,
      update: new Uint8Array([1]),
      meta: { origin: "agent:noop", seq: 0 },
      mutation: {
        actorKind: "agent",
        mode: "threadPeer",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        wId: 1,
        writeId: "noop-attempt",
        branchGeneration: harness.work.generation,
      },
    });
    const coordinator = harness.createAgentCoordinator(
      pending,
      createBranchConcurrentJournalWatermarks(),
      events,
    );

    await expect(coordinator.withDocument(DOCUMENT_ID, async () => undefined)).rejects.toThrow(
      StagedBranchWriteNoopError,
    );
    expect(harness.rows).toHaveLength(0);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "collab.branch_agent_edit",
        name: "staged_write.no_durable_journal_row",
      }),
    );
  });

  it("rejects a stale staged commit after a changed:false pull carries the reset generation", async () => {
    const harness = new ThreadPeerPushHarness("manual");
    const core = harness.createThreadPeerCore();

    const write = await core.write(
      {
        command: "insert",
        file: "chapter.md",
        documentId: DOCUMENT_ID,
        content: "Stale staged body.",
      },
      {
        sessionId: "session-stale",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-stale",
      },
    );
    expect(write.status).toBe("success");
    expect(harness.rows).toHaveLength(0);

    await harness.branchCoordinator.resetFromDocIfUnchangedWithLease(
      { covers: () => true } as never,
      { upstream: harness.liveDoc },
    );

    // The staged response path must use the generation captured by the public
    // thread-peer wrapper's changed:false pull. If response staging treats the
    // staged journal entry as success after the projection commit fails,
    // this resolves and silently loses the stale write.
    await expect(core.commitResponse("response-stale")).rejects.toThrow(
      /stale_branch_generation|staged journal batch/,
    );
    expect(harness.rows).toHaveLength(0);
    expect(markdown(docFromUpdate(harness.work.state))).not.toContain("Stale staged body.");
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
    deferUntilCommit: (callback) => {
      callback();
      return true;
    },
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
    resetFromDocIfUnchangedWithLease: vi.fn(async (_lease: unknown, input: { upstream: Y.Doc }) => {
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
        expectedJournalWatermark?: number;
        expectedJournalRevision?: string;
        updateMeta?: unknown;
      }) => {
        if (this.failNextCommitSync) {
          this.failNextCommitSync = false;
          return false;
        }
        const snapshot = this.snapshot(input.branchId);
        if (snapshot.generation !== input.expectedGeneration) {
          throw new Error("stale_branch_generation");
        }
        const expectedJournalWatermark = input.expectedJournalWatermark;
        if (
          expectedJournalWatermark !== undefined &&
          this.rows.some(
            (row) =>
              row.branchId === input.branchId &&
              row.generation === input.expectedGeneration &&
              row.id > expectedJournalWatermark,
          )
        ) {
          throw new Error("stale_branch_journal");
        }
        if (
          input.expectedJournalRevision !== undefined &&
          branchJournalRevision(
            this.rows.filter(
              (row) =>
                row.branchId === input.branchId && row.generation === input.expectedGeneration,
            ),
          ) !== input.expectedJournalRevision
        ) {
          throw new Error("stale_branch_journal");
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
          draftBaseUpdateSeq: 1,
          status: "active",
          updateMeta: input.updateMeta,
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
          draftBaseUpdateSeq: 1,
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
      listJournalRowsForTurn: vi.fn(async (input) => rowsForTurn(this.rows, input)),
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
        const entry = (
          this.journal as typeof this.journal & {
            debugEntry(documentId: string):
              | {
                  mutations: Array<{
                    wId: number;
                    documentId: string;
                    threadId: string;
                    turnId: string | null;
                    writeId: string;
                    status: "active";
                    createdSeq: number;
                    createdAt: Date;
                  }>;
                }
              | undefined;
          }
        ).debugEntry(input.branch.documentId);
        if (!entry) throw new Error("push update was not retained");
        for (const row of activeBranchAgentWriteRows(input.journalRows)) {
          entry.mutations.push({
            wId: row.wId,
            documentId: input.branch.documentId,
            threadId: row.threadId,
            turnId: row.turnId,
            writeId: `push:${input.branch.branchId}:${row.id}`,
            status: "active",
            createdSeq: seq,
            createdAt: new Date(),
          });
        }
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
      commitDiscard: vi.fn(async (input) => {
        this.work.state = input.state;
        this.work.stateVector = input.stateVector;
        for (const selected of input.journalRows) {
          const row = this.rows.find((candidate) => candidate.id === selected.id);
          if (row) row.status = "discarded";
        }
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
        actorKind: "agent",
        mode: "threadPeer",
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
    eventSink?: ReturnType<typeof createInMemoryEventSink>,
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
      diagnostics: createBranchAgentEditDiagnostics(eventSink),
      afterCommit(callback) {
        void callback();
      },
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
      liveJournal: this.journal,
    });
  }

  createThreadPeerCore() {
    const pending = createBranchPendingJournalEntries();
    const watermarks = createBranchConcurrentJournalWatermarks();
    const createCoreForCoordinator = (
      coordinator: DocumentCoordinator,
      journal: ReturnType<typeof createBranchAgentEditJournal> | typeof this.journal,
    ) =>
      createAgentEditCore({
        journal,
        coordinator,
        lifecycle: {
          ensureDocument: async () => undefined,
        },
        codec: agentCodec,
        model,
        defaultThreadId: THREAD_ID,
        createRuntimeDoc: () => createCollabYDoc({ gc: false }),
      });
    const branchJournal = createBranchAgentEditJournal({
      threadId: THREAD_ID,
      liveJournal: this.journal,
      pendingJournalEntries: pending,
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
      branchRows: {
        listJournalRowsForBranch: async (input) =>
          this.rows.filter(
            (row) => row.branchId === input.branchId && row.generation === input.generation,
          ),
      },
    });

    return createThreadPeerAgentEditCore({
      commitThreadResponseAtomically: (operation) => operation(),
      liveUtilityCore: asLiveAgentEditCore(
        createCoreForCoordinator(
          {
            withDocument: vi.fn(async (_docId, fn) => fn(this.liveDoc)),
            recover: vi.fn(),
          },
          this.journal,
        ),
      ),
      createThreadCore: () =>
        createCoreForCoordinator(this.createAgentCoordinator(pending, watermarks), branchJournal),
      shouldUseLiveReversal: async () =>
        !this.rows.some(
          (row) =>
            row.branchId === this.work.branchId &&
            row.generation === this.work.generation &&
            row.status === "active" &&
            row.source === "agent" &&
            row.threadId === THREAD_ID &&
            row.wId !== null,
        ),
      pullThreadPeer: async () => ({
        branchGeneration: this.work.generation,
        afterJournalId: 0,
        attributionBaseline: this.thread.state,
      }),
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
