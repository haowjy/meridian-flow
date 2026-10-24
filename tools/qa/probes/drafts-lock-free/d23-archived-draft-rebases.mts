/**
 * Decision D23 (the Work archive rule): an archived Work's draft keeps rebasing on live, so it
 * applies cleanly after unarchive. A live edit made after Archive reaches the draft through the
 * background pull; unarchive finds nothing to catch up; a writer frame on the archived draft is
 * still refused, since the freeze stops the writer, not the rebase.
 */
import assert from "node:assert/strict";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDraftPullService } from "../../../../apps/server/server/domains/collab/domain/draft-pulls.ts";
import { materializeDraftRead } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import {
  appendToFirstParagraph,
  independently,
  observe,
  type Probe,
  settled,
  Y,
} from "./harness.mts";

export const d23ArchivedDraftRebases: Probe = {
  name: "d23-archived-draft-rebases",
  decision: "D23",
  expected:
    "archived: the live edit reaches the draft; unarchived: the text is already there, checkpoint unmoved; a writer frame while archived rejects `DraftStaleUpdateError`",
  async run(harness) {
    const { workId, branchId } = await harness.seedWork("archived-rebase");
    const { documentId, live } = await harness.seedDocument("archived-rebase", "Base");
    const documentDraft = await harness.store.ensureDocumentDraft({
      documentId,
      branchId,
      liveDoc: live,
      liveRoom: null,
    });
    const pulls = createDraftPullService({
      outsideTransaction: independently,
      drafts: harness.store,
      liveJournal: harness.persistence.journal,
      draftCoordinator: harness.coordinator,
    });
    try {
      await harness.works.archive(workId);
      const update = appendToFirstParagraph(live, " AFTER ARCHIVE");
      await harness.persistence.journal.append(documentId, update, { origin: "system", seq: 0 });
      await pulls.flushLivePull(documentId as DocumentId);
      const archived = await harness.readDraft(documentDraft.draftId);
      observe("archived", archived);
      assert.equal(archived.lifecycle, "archived");
      assert.match(archived.text, /Base AFTER ARCHIVE/);

      const read = await harness.store.readDraftAt(documentDraft.draftId);
      if (!read) throw new Error("Draft is missing");
      const room = materializeDraftRead(read);
      try {
        const before = Y.encodeStateVector(room);
        appendToFirstParagraph(room, " WRITER");
        const frame = await settled(
          harness.coordinator.commitWriterUpdate({
            draftId: documentDraft.draftId,
            updateData: Y.encodeStateAsUpdate(room, before),
            roomDocument: room,
          }),
        );
        observe("writer frame", frame);
        assert.equal(frame.ok ? undefined : frame.name, "DraftStaleUpdateError");
      } finally {
        room.destroy();
      }

      await harness.works.unarchive(workId);
      const unarchived = await harness.readDraft(documentDraft.draftId);
      observe("unarchived", unarchived);
      assert.equal(unarchived.lifecycle, "active");
      assert.equal(unarchived.text, archived.text);
      assert.equal(unarchived.checkpointRevision, archived.checkpointRevision);
      assert.doesNotMatch(unarchived.text, /WRITER/);
    } finally {
      pulls.cancelScheduledPulls();
      live.destroy();
    }
  },
};
