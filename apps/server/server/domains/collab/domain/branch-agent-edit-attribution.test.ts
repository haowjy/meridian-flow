/** Attribution must skip covered history without caching away a later concurrency recheck. */
import { renderAgentEditResult } from "@meridian/agent-edit";
import {
  applyConcurrentUpdates,
  cloneYDoc,
  createAgentEditCodec,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { blockTexts, createWriteToolHarness, humanText } from "@meridian/agent-edit/test-support";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { unimplementedBranchMutations } from "../test-support/unimplemented-branch-mutations.js";
import { createBranchAgentEditCoordinator } from "./branch-agent-edit.js";
import { type BranchSnapshot, createBranchCoordinator } from "./branch-coordinator.js";
import type { BranchJournalRow } from "./branch-push-contracts.js";

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);
const threadId = "00000000-0000-4000-8000-000000000003" as ThreadId;
const documentId = "00000000-0000-4000-8000-000000000004" as DocumentId;
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

function fixture(existingUpstream?: Y.Doc) {
  const codec = createAgentEditCodec(
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
  );
  const serialize = vi.spyOn(codec, "serializeBlockBodies");
  const upstream = existingUpstream ?? new Y.Doc({ gc: false });
  if (!existingUpstream)
    model.insertBlocks(toDocHandle(upstream), null, codec.parse("Alpha.\n\nBeta."));
  const baseline = cloneYDoc(upstream);
  docs.push(upstream, baseline);
  const rows: BranchJournalRow[] = [];
  const liveUpdates: Array<{
    seq: number;
    update: Uint8Array;
    meta: { origin: string; seq: number };
  }> = [];
  const snapshot = (branchId: string): BranchSnapshot => ({
    branchId,
    documentId,
    kind: "work_draft",
    upstreamBranchId: branchId === "peer" ? "draft" : null,
    workId: null,
    threadId: null,
    status: "active",
    generation: 1,
    state: Y.encodeStateAsUpdate(upstream),
    stateVector: Y.encodeStateVector(upstream),
    schemaVersion: COLLAB_SCHEMA_VERSION,
  });
  const coordinator = createBranchAgentEditCoordinator({
    threadId,
    model,
    codec,
    liveCoordinator: { withDocument: async (_id, fn) => fn(upstream), recover: async () => {} },
    branchCoordinator: createBranchCoordinator({
      store: {
        getBranch: async (id) => snapshot(id),
        updateBranchSnapshot: async () => true,
        deferUntilCommit: () => false,
        ...unimplementedBranchMutations(),
      },
    }),
    branches: {
      getBranch: async (id) => snapshot(id),
      resolveThreadBranch: async () => ({
        branchId: "peer",
        generation: 1,
        doc: cloneYDoc(baseline),
      }),
      ensureThreadPeerBranch: async () => ({ branchId: "peer" }),
      ensureWorkDraftBranch: async () => ({ branchId: "draft" }),
      listActiveWorkDraftBranchIds: async () => ["draft"],
    },
    journalRows: {
      listConcurrentJournalRows: async () => rows,
    },
    liveJournal: {
      readForReconstruction: async () => ({ checkpoint: null, updates: liveUpdates }),
    },
    afterCommit: () => {},
    enlistResponseParticipant: () => false,
  });
  function row(updateData: Uint8Array): BranchJournalRow {
    return {
      id: rows.length + 1,
      branchId: "draft",
      generation: 1,
      wId: null,
      source: "writer",
      threadId: null,
      turnId: null,
      actorUserId: null,
      updateData,
      draftBaseUpdateSeq: 0,
      status: "active",
    };
  }
  async function check() {
    const changes = await coordinator.concurrentUpdatesSince?.({
      docId: documentId,
      doc: upstream,
      baselineDoc: baseline,
      sinceStateVector: Y.encodeStateVector(baseline),
      liveJournalSeq: 0,
    });
    if (!changes) throw new Error("Missing branch attribution");
    return changes;
  }
  return { upstream, baseline, rows, liveUpdates, row, check, serialize, coordinator };
}

describe("branch concurrent attribution", () => {
  it.each([
    "link-update",
    "system:reconcile",
  ])("keeps %s neutral while converging its bytes", async (origin) => {
    const f = fixture();
    const before = Y.encodeStateVector(f.upstream);
    humanText(f.upstream, 0, { from: 5, to: 5 }, " maintenance");
    f.liveUpdates.push({
      seq: 1,
      update: Y.encodeStateAsUpdate(f.upstream, before),
      meta: { origin, seq: 1 },
    });
    const changes = await f.check();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ origin: { type: "system" }, touchedHashes: {} });
    const codec = createAgentEditCodec(
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    );
    const echo = applyConcurrentUpdates(toDocHandle(f.baseline), model, codec, changes);
    expect(blockTexts(f.baseline)).toEqual(blockTexts(f.upstream));
    expect(echo.humanTouchedHashes.size).toBe(0);
    expect(echo.touchedHashes.size).toBe(0);
    expect(echo.lineageOrigins).toEqual([]);
    expect(echo.info).toBeUndefined();
  });

  it.each([
    "agent",
    "writer",
  ] as const)("preserves %s coverage when maintenance follows on the same block", async (source) => {
    const f = fixture();
    let before = Y.encodeStateVector(f.upstream);
    humanText(f.upstream, 0, { from: 5, to: 5 }, " authored");
    f.rows.push({ ...f.row(Y.encodeStateAsUpdate(f.upstream, before)), source });
    before = Y.encodeStateVector(f.upstream);
    humanText(f.upstream, 0, { from: 5, to: 5 }, " maintenance");
    f.liveUpdates.push({
      seq: 1,
      update: Y.encodeStateAsUpdate(f.upstream, before),
      meta: { origin: "link-update", seq: 1 },
    });
    const changes = await f.check();
    expect(changes[0]).toMatchObject({
      touchedHashes: { [source === "agent" ? "agent" : "human"]: [expect.any(String)] },
    });
    expect(changes[1]).toMatchObject({ origin: { type: "system" }, touchedHashes: {} });
    const codec = createAgentEditCodec(
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    );
    const echo = applyConcurrentUpdates(toDocHandle(f.baseline), model, codec, changes);
    expect(echo.info?.[source === "agent" ? "agent" : "human"]).toHaveLength(1);
    expect(echo.info?.[source === "agent" ? "human" : "agent"]).toEqual([]);
  });

  it("does not credit a reconciliation's deleted block to the writer", async () => {
    const f = fixture();
    const before = Y.encodeStateVector(f.upstream);
    model.deleteBlock(toDocHandle(f.upstream), model.getBlocks(toDocHandle(f.upstream))[0]);
    f.liveUpdates.push({
      seq: 1,
      update: Y.encodeStateAsUpdate(f.upstream, before),
      meta: { origin: "system:reconcile", seq: 1 },
    });
    const changes = await f.check();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ origin: { type: "system" }, touchedHashes: {} });
    expect(changes[0]?.deletedHashes).toBeUndefined();
    const codec = createAgentEditCodec(
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    );
    const echo = applyConcurrentUpdates(toDocHandle(f.baseline), model, codec, changes);
    expect(blockTexts(f.baseline)).toEqual(["Beta."]);
    expect(echo.info).toBeUndefined();
  });

  it("does not relabel maintenance when the recheck baseline is ahead of the Work draft", async () => {
    const f = fixture();
    const live = cloneYDoc(f.baseline);
    docs.push(live);
    const before = Y.encodeStateVector(live);
    humanText(live, 0, { from: 5, to: 5 }, " maintenance");
    const update = Y.encodeStateAsUpdate(live, before);
    f.liveUpdates.push({ seq: 1, update, meta: { origin: "link-update", seq: 1 } });
    expect((await f.check())[0]?.origin).toEqual({ type: "system" });
    Y.applyUpdate(f.baseline, update);
    expect(await f.check()).toEqual([]);
  });

  it("reports writer content arriving after the fast preflight in the actual response save", async () => {
    let afterPreflight = () => {};
    const ctx = createWriteToolHarness(
      { "chapter.md": "Alpha para.\n\nBeta para." },
      {
        afterResponsePreflight: () => afterPreflight(),
      },
    );
    const f = fixture(ctx.liveDoc("chapter.md"));
    f.rows.push(f.row(Y.encodeStateAsUpdate(f.baseline)));
    ctx.coordinator.concurrentUpdatesSince = f.coordinator.concurrentUpdatesSince;
    const context = {
      sessionId: "session",
      threadId: "thread-a",
      turnId: "turn-late",
      responseId: "reply-late",
    };
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", in: 1, content: "Alpha AI edit." },
      context,
    );
    afterPreflight = () => {
      expect(f.serialize).not.toHaveBeenCalled();
      const vector = Y.encodeStateVector(f.upstream);
      humanText(f.upstream, 0, { from: 11, to: 11 }, " WRITER");
      f.rows.push(f.row(Y.encodeStateAsUpdate(f.upstream, vector)));
    };
    const saved = await ctx.core.commitResponse("reply-late");
    expect(blockTexts(f.upstream)).toEqual(["Alpha AI edit. WRITER", "Beta para."]);
    const receipt = saved.documents[0]?.receipts.at(-1)?.result;
    if (!receipt) throw new Error("Missing saved receipt");
    expect(renderAgentEditResult(receipt)).toContain(
      "concurrent user content swept during commit; re-read required",
    );
    expect(f.serialize).toHaveBeenCalled();
  });

  it("does no block projection for identical states with retained, covered journal rows", async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++) f.rows.push(f.row(Y.encodeStateAsUpdate(f.baseline)));
    expect(await f.check()).toEqual([]);
    expect(f.serialize).not.toHaveBeenCalled();
  });

  it("rechecks a writer deletion after an identical-state preflight, despite equal state vectors", async () => {
    const f = fixture();
    f.rows.push(f.row(Y.encodeStateAsUpdate(f.baseline)));
    expect(await f.check()).toEqual([]);
    const before = Y.encodeStateVector(f.upstream);
    model.deleteBlock(toDocHandle(f.upstream), model.getBlocks(toDocHandle(f.upstream))[0]);
    f.rows.push(f.row(Y.encodeStateAsUpdate(f.upstream, before)));
    expect(Y.encodeStateVector(f.upstream)).toEqual(before);
    const recheck = await f.check();
    expect(recheck).toHaveLength(1);
    expect(recheck[0]).toMatchObject({
      origin: { type: "human" },
      deletedHashes: { human: [expect.any(String)] },
    });
    expect(recheck[0].update.byteLength).toBeGreaterThan(0);
  });

  it("does not suppress live journal edits that have not reached an identical upstream", async () => {
    const f = fixture();
    const live = cloneYDoc(f.baseline);
    docs.push(live);
    const before = Y.encodeStateVector(live);
    const codec = createAgentEditCodec(
      mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    );
    model.insertBlocks(toDocHandle(live), null, codec.parse("Writer."));
    f.liveUpdates.push({
      seq: 1,
      update: Y.encodeStateAsUpdate(live, before),
      meta: { origin: "human:writer", seq: 1 },
    });
    const changes = await f.check();
    expect(changes).toContainEqual(
      expect.objectContaining({ origin: { type: "human", userId: "writer" } }),
    );
    expect(changes.some((change) => change.update.byteLength > 0)).toBe(true);
  });
});
