/**
 * Decision D23 (the Work archive rule): an archived Work's draft opened read-only shows current
 * text, since the freeze stops the writer, not the rebase. A live edit made after Archive reaches
 * the draft only while a room is open on it: the push skips an unopened draft, and opening it
 * catches it up. Unarchive finds nothing to catch up; a writer frame on the archived draft is
 * still refused.
 */
import assert from "node:assert/strict";
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
    "archived: an unopened draft is left alone, opening it catches it up, a later live edit reaches it while open; unarchived: the text is already there, checkpoint unmoved; a writer frame while archived rejects `DraftStaleUpdateError`",
  async run(harness) {
    const { workId, branchId } = await harness.seedWork("archived-rebase");
    const { documentId, live } = await harness.seedDocument("archived-rebase", "Base");
    const documentDraft = await harness.store.ensureDocumentDraft({
      documentId,
      branchId,
      liveDoc: live,
      liveRoom: null,
    });
    const openRooms: string[] = [];
    const pulls = createDraftPullService({
      outsideTransaction: independently,
      openDraftRooms: async () => openRooms,
      debounceMs: 5,
      maxDebounceMs: 20,
      liveJournal: harness.persistence.journal,
      draftCoordinator: harness.coordinator,
    });
    try {
      await harness.works.archive(workId);
      const update = appendToFirstParagraph(live, " AFTER ARCHIVE");
      await harness.persistence.journal.append(documentId, update, { origin: "system", seq: 0 });
      pulls.liveCommitted(documentId);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const unopened = await harness.readDraft(documentDraft.draftId);
      observe("unopened", unopened);
      assert.doesNotMatch(unopened.text, /AFTER ARCHIVE/);

      // Opened read-only: the room's first catch-up reads Live, though the Work is archived.
      openRooms.push(documentDraft.draftId);
      await pulls.catchUpDraft(documentDraft.draftId);
      const opened = await harness.readDraft(documentDraft.draftId);
      assert.match(opened.text, /Base AFTER ARCHIVE/);
      const second = appendToFirstParagraph(live, " AGAIN");
      await harness.persistence.journal.append(documentId, second, { origin: "system", seq: 0 });
      pulls.liveCommitted(documentId);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const archived = await harness.readDraft(documentDraft.draftId);
      observe("archived", archived);
      assert.equal(archived.lifecycle, "archived");
      assert.match(archived.text, /Base AFTER ARCHIVE AGAIN/);

      const read = await harness.store.readDraftAt(documentDraft.draftId);
      if (!read) throw new Error("Draft is missing");
      const room = materializeDraftRead(read);
      try {
        const before = Y.encodeStateVector(room);
        appendToFirstParagraph(room, " WRITER");
        const frame = await settled(
          harness.coordinator.appendWriterFrame({
            draftId: documentDraft.draftId,
            updateData: Y.encodeStateAsUpdate(room, before),
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
