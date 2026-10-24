/** Attribution must skip covered history without caching away a later concurrency recheck.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Covered journal history is skipped
 */
import { renderAgentEditResult } from "@meridian/agent-edit";
import {
  cloneYDoc,
  createAgentEditCodecFactory,
  type ObservationFrontier,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { blockTexts, createWriteToolHarness, humanText } from "@meridian/agent-edit/test-support";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MemoryDraftStore, memoryDraft, testDraftRow } from "../test-support/memory-draft-store.js";
import { createDraftAgentEditCoordinator } from "./draft-agent-edit.js";
import { createDraftCoordinator } from "./draft-coordinator.js";
import type { DraftJournalRow } from "./draft-journal.js";
import type { DraftSnapshot } from "./draft-store.js";

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);
const threadId = "00000000-0000-4000-8000-000000000003" as ThreadId;
const documentId = "00000000-0000-4000-8000-000000000004" as DocumentId;
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

function fixture(existingUpstream?: Y.Doc) {
  const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
  const upstream = existingUpstream ?? new Y.Doc({ gc: false });
  if (!existingUpstream)
    model.insertBlocks(toDocHandle(upstream), null, codec.parse("Alpha.\n\nBeta."));
  const baseline = cloneYDoc(upstream);
  docs.push(upstream, baseline);
  const rows: DraftJournalRow[] = [];
  const snapshot = (draftId: string): DraftSnapshot =>
    testDraftRow({ draftId, documentId, upstreamDraftId: draftId === "peer" ? "draft" : null });
  const coordinator = createDraftAgentEditCoordinator({
    removals: { lookup: async () => new Map() },
    threadId,
    liveJournal: {
      readUpdates: async () => [],
    },
    draftCoordinator: createDraftCoordinator({
      onAppendCommitted: () => {},
      store: new MemoryDraftStore(
        ["draft", "peer"].map((id) => memoryDraft(snapshot(id), upstream)),
      ),
    }),
    drafts: {
      getDraft: async (id) => snapshot(id),
      resolveThreadDraft: async () => ({
        draftId: "peer",
        status: "active",
        lifecycle: "active",
        seed: null,
      }),
      ensureThreadPeerDraft: async () => ({
        documentDraft: snapshot("peer"),
        workDraft: snapshot("draft"),
      }),
      listActiveWorkDraftIds: async () => ["draft"],
      resolveWorkDraftForThread: async () => snapshot("draft"),
    },
    flushLivePull: async () => {},
    branches: { shareActive: async () => null },
    journalRows: {
      listConcurrentJournalRows: async () => rows,
      listJournalRowsForDraft: async () => [],
    },
  });
  function row(updateData: Uint8Array): DraftJournalRow {
    return {
      id: rows.length + 1,
      draftId: "draft",
      wId: null,
      source: "writer",
      threadId: null,
      turnId: null,
      actorUserId: null,
      updateData,
      status: "active",
    };
  }
  async function check() {
    const changes = await coordinator.concurrentUpdatesForReport?.({
      docId: documentId,
      doc: upstream,
      baselineDoc: baseline,
      after: 0,
      through: rows.length,
    });
    if (!changes) throw new Error("Missing draft attribution");
    return changes;
  }
  return { upstream, baseline, rows, row, check, coordinator };
}

describe("draft concurrent attribution", () => {
  it("reports writer content arriving before the save reads the room in the actual response save", async () => {
    let beforeSave = () => {};
    const ctx = createWriteToolHarness({ "chapter.md": "Alpha para.\n\nBeta para." });
    const prepareSave = ctx.coordinator.prepareSave.bind(ctx.coordinator);
    ctx.coordinator.prepareSave = async (input) => {
      beforeSave();
      return prepareSave(input);
    };
    const f = fixture(ctx.liveDoc("chapter.md"));
    f.rows.push(f.row(Y.encodeStateAsUpdate(f.baseline)));
    ctx.coordinator.concurrentUpdatesForReport = f.coordinator.concurrentUpdatesForReport;
    let frontier: ObservationFrontier | null = null;
    const context = {
      sessionId: "session",
      threadId: "thread-a",
      turnId: "turn-late",
      responseIdentity: { providerResponseId: "reply-late", editScopeId: "reply-late" },
      frontiers: {
        recording: async () => frontier,
        planning: async () => frontier,
      },
    };
    const read = await ctx.core.read({ file: "chapter.md" }, context);
    frontier = read.frontier ?? null;
    await ctx.core.write(
      { command: "replace", file: "chapter.md", in: 1, content: "Alpha AI edit." },
      context,
    );
    beforeSave = () => {
      const vector = Y.encodeStateVector(f.upstream);
      humanText(f.upstream, 0, { from: 11, to: 11 }, " WRITER");
      f.rows.push(f.row(Y.encodeStateAsUpdate(f.upstream, vector)));
    };
    const saved = await ctx.core.commitResponse("reply-late", {
      recordingFrontier: async () => frontier,
    });
    expect(blockTexts(f.upstream)).toEqual(["Alpha AI edit. WRITER", "Beta para."]);
    const receipt = saved.documents[0]?.receipts.at(-1)?.result;
    if (!receipt) throw new Error("Missing saved receipt");
    const rendered = renderAgentEditResult(receipt);
    expect(rendered).toContain("Alpha AI edit. WRITER");
    expect(rendered).toContain("concurrent edits by the user:");
  });

  it("skips retained journal rows the baseline already contains", async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++) f.rows.push(f.row(Y.encodeStateAsUpdate(f.baseline)));
    expect(await f.check()).toEqual([]);
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
    expect(recheck[0]).toMatchObject({ origin: { type: "human" } });
    expect(recheck[0].update.byteLength).toBeGreaterThan(0);
  });
});
