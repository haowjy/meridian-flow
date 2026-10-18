/**
 * Decision D23 (the Work archive rule): an archived Work's draft keeps rebasing on live, so it
 * applies cleanly after unarchive. A live edit made after Archive reaches the draft through the
 * background pull; unarchive finds nothing to catch up; a writer frame on the archived draft is
 * still refused, since the freeze stops the writer, not the rebase.
 */
import assert from "node:assert/strict";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createBranchPullService } from "../../../../apps/server/server/domains/collab/domain/branch-pulls.ts";
import { materializeBranchRead } from "../../../../apps/server/server/domains/collab/domain/branch-store.ts";
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
    "archived: the live edit reaches the draft; unarchived: the text is already there, checkpoint unmoved; a writer frame while archived rejects `BranchStaleUpdateError`",
  async run(harness) {
    const { workId, draftId } = await harness.seedWork("archived-rebase");
    const { documentId, live } = await harness.seedDocument("archived-rebase", "Base");
    const branch = await harness.store.ensureDraftBranch({ documentId, draftId, liveDoc: live });
    const pulls = createBranchPullService({
      outsideTransaction: independently,
      branches: harness.store,
      branchCoordinator: harness.coordinator,
      liveCoordinator: {
        withDocument: async (_id: string, run: (doc: typeof live) => unknown) => run(live),
      } as never,
    });
    try {
      await harness.works.archive(workId);
      appendToFirstParagraph(live, " AFTER ARCHIVE");
      await pulls.flushLivePull(documentId as DocumentId);
      const archived = await harness.readBranch(branch.branchId);
      observe("archived", archived);
      assert.equal(archived.lifecycle, "archived");
      assert.match(archived.text, /Base AFTER ARCHIVE/);

      const read = await harness.store.readBranchAt(branch.branchId);
      if (!read) throw new Error("Branch is missing");
      const room = materializeBranchRead(read);
      try {
        const before = Y.encodeStateVector(room);
        appendToFirstParagraph(room, " WRITER");
        const frame = await settled(
          harness.coordinator.commitWriterUpdate({
            branchId: branch.branchId,
            expectedGeneration: read.branch.generation,
            updateData: Y.encodeStateAsUpdate(room, before),
            roomDocument: room,
          }),
        );
        observe("writer frame", frame);
        assert.equal(frame.ok ? undefined : frame.name, "BranchStaleUpdateError");
      } finally {
        room.destroy();
      }

      await harness.works.unarchive(workId);
      const unarchived = await harness.readBranch(branch.branchId);
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
