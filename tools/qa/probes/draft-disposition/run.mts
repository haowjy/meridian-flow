/** G1: exercise text-derived inverse policy and whole-Work close against real PostgreSQL adapters. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { createDrizzleBranchDiscard } from "../../../../apps/server/server/domains/collab/adapters/drizzle-branch-discard.ts";
import {
  captureReceiptRows,
  recordDocumentEdit,
} from "../../../../apps/server/server/domains/collab/adapters/drizzle-document-edits.ts";
import { createDraftClose } from "../../../../apps/server/server/domains/collab/adapters/drizzle-draft-close.ts";
import { createDrizzleDraftDispositionStore } from "../../../../apps/server/server/domains/collab/adapters/drizzle-draft-disposition.ts";
import { createDrizzleTurnInverseService } from "../../../../apps/server/server/domains/collab/adapters/drizzle-turn-inverse.ts";
import { createDraftDispositionReader } from "../../../../apps/server/server/domains/collab/domain/draft-disposition.ts";
import { runWithEditConfirmation } from "../../../../apps/server/server/shared/edit-confirmation.ts";
import { createTestDocumentRemoval } from "../../../../apps/server/server/test-support/document-removal.ts";
import {
  appendApplyRecord,
  applyRecordOf,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "../../../../packages/agent-edit/src/diff/index.ts";
import { workGrant } from "../drafts-lock-free/f1-inverse-grant.mts";
import { createScratchDatabase, observe, openHarness, Y } from "../drafts-lock-free/harness.mts";

const pm = buildDocumentSchema();
const scratch = await createScratchDatabase();
const h = await openHarness(scratch.url);
const read = createDraftDispositionReader(createDrizzleDraftDispositionStore(h.db));
const docs: Y.Doc[] = [];
try {
  const work = await h.seedWork("g1-disposition");
  const inverse = createDrizzleTurnInverseService({
    db: h.db,
    journal: h.persistence.journal,
    drafts: h.store,
    coordinator: {
      async withDocument<T>(id: string, run: (doc: Y.Doc) => Promise<T>) {
        const doc = await h.liveDoc(id);
        try {
          return await run(doc);
        } finally {
          doc.destroy();
        }
      },
      async recover() {},
    } as never,
    draftCoordinator: { async deliverCommitted() {} },
    resolveDocumentUri: async () => "project://probe.md",
    async refreshDocument() {},
    async flushLivePull() {},
    notices: { async record() {} },
    workProjection: h.projection,
    onDraftCommitted: () => {},
  });

  async function fixture(label: string, deletion = false) {
    const { documentId, live } = await h.seedDocument(label, "The old mountain waits.");
    const doc = live;
    docs.push(doc);
    doc.clientID = 1;
    doc.transact(() => {
      const blocks = [pm.nodes.paragraph.create(null, pm.text("The old mountain waits."))];
      writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), pm, blocks);
      writeBlocks(doc.getXmlFragment("prosemirror"), pm, blocks);
    });
    // DV-style explicit two-fragment fixture: lane R owns replacing production's old seeder.
    await h.persistence.journal.append(documentId, Y.encodeStateAsUpdate(doc), {
      origin: "system",
      seq: 0,
    });
    const draftId = `g1-${randomUUID()}`;
    await h.raw`insert into document_drafts(id,branch_id,document_id,kind,state,state_vector,live_cut,has_effect) values (${draftId},${work.branchId},${documentId},'work_draft',${Buffer.from(Y.encodeStateAsUpdate(doc))},${Buffer.from(Y.encodeStateVector(doc))},${Buffer.from(Y.encodeStateAsUpdate(doc))},true)`;
    const before = new Y.Doc({ gc: false });
    Y.applyUpdate(before, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(doc);
    doc.clientID = 321;
    const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    if (deletion) text.delete(4, 4);
    else text.insert(text.length, " AI");
    const update = Y.encodeStateAsUpdate(doc, vector);
    const wId = await h.persistence.journal.reserveWriteOrdinal(documentId, work.threadId);
    const [row] =
      await h.raw`insert into draft_write_journal(draft_id,generation,draft_base_update_seq,update_data,source,thread_id,turn_id,w_id) values (${draftId},0,0,${Buffer.from(update)},'agent',${work.threadId},${work.turnId},${wId}) returning id`;
    const editId = await recordDocumentEdit(h.db, {
      documentId,
      threadId: work.threadId as never,
      turnId: work.turnId as never,
      actor: "agent",
      wId,
      receipts: captureReceiptRows(before, [
        { update, origin: { kind: "pending", draftId, generation: 0, rowId: Number(row.id) } },
      ]),
    });
    before.destroy();
    async function save() {
      await h.raw`update document_drafts set state=${Buffer.from(Y.encodeStateAsUpdate(doc))},state_vector=${Buffer.from(Y.encodeStateVector(doc))},checkpoint_seq=${row.id},revision=revision+1,checkpoint_revision=revision+1 where id=${draftId}`;
    }
    await save();
    async function command(command: "undo" | "revert") {
      return runWithEditConfirmation(workGrant(h, work.workId), () =>
        inverse.modelInverse(
          {
            threadId: work.threadId as never,
            turnId: work.turnId as never,
            documentIds: [documentId],
            draftId,
            model: true,
          },
          command === "revert"
            ? { command, file: "project://probe.md", edit: `w${wId}` }
            : { command, file: "project://probe.md" },
        ),
      );
    }
    return { doc, text, draftId, documentId, editId, save, command };
  }

  const discarded = await fixture("discarded-by-edit");
  discarded.doc.clientID = 654;
  discarded.text.delete(discarded.text.length - 3, 3);
  await discarded.save();
  assert.equal((await read(discarded.draftId))?.parts[0].disposition, "discarded");
  const discardedBefore = await h.readDraft(discarded.draftId);
  const discardResult = await discarded.command("revert");
  observe("revert discarded by edit", {
    status: discardResult.status,
    message: discardResult.message,
  });
  assert.equal(discardResult.status, "nothing_to_revert");
  assert.match(discardResult.message, /discarded/i);
  assert.equal((await h.readDraft(discarded.draftId)).text, discardedBefore.text);

  const deleted = await fixture("deletion-only", true);
  assert.equal((await read(deleted.draftId))?.parts[0].disposition, "pending");
  const deletedResult = await deleted.command("revert");
  observe("revert deletion-only", { status: deletedResult.status, message: deletedResult.message });
  assert.equal(deletedResult.status, "success");
  assert.match((await h.readDraft(deleted.draftId)).text, /The old mountain waits/);

  const applied = await fixture("applied");
  const beforeApply = await read(applied.draftId);
  assert(beforeApply);
  // Build Apply evidence directly while lane A owns the HTTP Apply implementation.
  applied.doc.clientID = 1;
  applied.doc.transact(() => {
    appendApplyRecord(
      applied.doc,
      applyRecordOf(beforeApply.classifications, beforeApply.classifications.keys()),
    );
    writeBlocks(
      applied.doc.getXmlFragment(REVIEW_BASE_FRAGMENT),
      pm,
      readBlocks(applied.doc.getXmlFragment("prosemirror"), pm),
    );
  });
  await applied.save();
  await h.persistence.journal.append(applied.documentId, Y.encodeStateAsUpdate(applied.doc), {
    origin: "system",
    seq: 0,
  });
  assert.equal((await read(applied.draftId))?.parts[0].disposition, "applied");
  const liveBefore = await h.liveText(applied.documentId);
  const undoResult = await applied.command("undo");
  observe("undo applied", { status: undoResult.status, message: undoResult.message });
  assert.equal(undoResult.status, "cant_undo_applied");
  const appliedResult = await applied.command("revert");
  observe("revert applied", { status: appliedResult.status, message: appliedResult.message });
  assert.equal(appliedResult.status, "success");
  assert.equal(await h.liveText(applied.documentId), liveBefore);
  assert.notEqual((await h.readDraft(applied.draftId)).text, liveBefore);
  const afterRevert = await read(applied.draftId);
  assert(afterRevert);
  assert.equal(afterRevert.projection?.hasChanges, true);
  assert.ok(
    afterRevert.parts.some((p) => p.editId !== applied.editId && p.disposition === "pending"),
  );

  const closing = await Promise.all([fixture("close-one"), fixture("close-two")]);
  const partsBefore =
    await h.raw`select id,origin,placement,effect from document_edit_parts order by id`;
  const journalBefore = await h.raw`select id,status from draft_write_journal order by id`;
  const close = createDraftClose();
  const discard = createDrizzleBranchDiscard(h.db, {
    close,
    branches: h.branches,
    workProjection: h.projection,
    removal: createTestDocumentRemoval(h.db),
    catalog: {
      async refreshSources() {
        return "0";
      },
    },
  });
  await discard.discardLocked({
    workId: work.workId,
    kernel: { branchId: work.branchId, selection: { kind: "whole" } },
  });
  const closed =
    await h.raw`select id,status,closed_cause from document_drafts where branch_id=${work.branchId} order by id`;
  observe("Discard all draft lifecycle", closed);
  assert.ok(closed.length >= 5);
  assert.ok(closed.every((row) => row.status === "closed" && row.closed_cause === "discarded"));
  assert.deepEqual(
    await h.raw`select id,origin,placement,effect from document_edit_parts order by id`,
    partsBefore,
  );
  assert.deepEqual(
    await h.raw`select id,status from draft_write_journal order by id`,
    journalBefore,
  );
  for (const f of closing)
    assert.ok((await read(f.draftId))?.parts.every((p) => p.disposition === "discarded"));
  assert.equal(
    (await read(applied.draftId))?.parts.find((p) => p.editId === applied.editId)?.disposition,
    "applied",
  );
  observe(
    "closed historical Apply evidence",
    "applied receipt retained; non-applied receipts discarded",
  );
  const closedLive = await h.liveText(applied.documentId);
  const closedRevert = await applied.command("revert");
  observe("closed draft never writable", {
    status: closedRevert.status,
    message: closedRevert.message,
  });
  assert.equal(closedRevert.status, "nothing_to_revert");
  assert.match(closedRevert.message, /discarded/i);
  assert.equal(await h.liveText(applied.documentId), closedLive);
  assert.deepEqual(
    await h.raw`select id,origin,placement,effect from document_edit_parts order by id`,
    partsBefore,
  );
  console.log("PASS G1 disposition and close");
} finally {
  for (const doc of docs) doc.destroy();
  await h.close();
  await scratch.drop();
}
