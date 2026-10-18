/**
 * Decision D12: creating a Work draft branch enters the Work-first boundary, so it cannot escape
 * Archive. Archive pauses inside its transaction after its Work update; a branch ensure for a new
 * document waits on the Work row, lands only after Archive commits, and is derived archived: a
 * writer frame into it is refused and nothing is written.
 */
import assert from "node:assert/strict";
import { materializeBranchRead } from "../../../../apps/server/server/domains/collab/domain/branch-store.ts";
import { createDrizzleWorkRepository } from "../../../../apps/server/server/domains/projects/adapters/work-repository/drizzle.ts";
import {
  appendToFirstParagraph,
  gate,
  independently,
  observe,
  type Probe,
  settled,
  Y,
} from "./harness.mts";

export const d12CreateDuringArchive: Probe = {
  name: "d12-create-during-archive",
  decision: "D12",
  expected:
    "the ensure waits on the Work row until Archive commits; the new branch is archived and refuses a writer frame",
  async run(harness) {
    const { workId, draftId } = await harness.seedWork("create-archive");
    const paused = gate();
    const finish = gate();
    let pause = true;
    // Archive's Works notice runs inside its transaction, after its Work update.
    const works = createDrizzleWorkRepository({
      db: harness.db,
      projectionMutation: {
        ...harness.projection,
        async notifyWorksChanged(ids) {
          if (pause) {
            pause = false;
            paused.open();
            await finish.wait;
          }
          return harness.projection.notifyWorksChanged(ids);
        },
      },
      fileAccessChanges: { publish: async () => {} },
      lineageScratch: {} as never,
    });
    const { documentId, live } = await harness.seedDocument("create-archive", "Fresh");
    try {
      const archive = settled(independently(() => works.archive(workId)));
      await paused.wait;
      const archivedBefore = await harness.workArchived(workId);
      const ensuring = settled(
        independently(() =>
          harness.store.ensureDraftBranch({ documentId, draftId, liveDoc: live }),
        ),
      );
      const waiting = await harness.waitForLockWaiter(/works/);
      finish.open();
      assert.equal((await archive).ok, true);
      const ensured = await ensuring;
      if (!ensured.ok) throw new Error(`ensure failed: ${ensured.message}`);
      const branch = ensured.value;
      const read = await harness.store.readBranchAt(branch.branchId);
      if (!read) throw new Error("ensured branch is missing");
      const room = materializeBranchRead(read);
      room.clientID = 777_001;
      const update = appendToFirstParagraph(room, " AFTER ARCHIVE");
      const frame = await settled(
        harness.coordinator.commitWriterUpdate({
          branchId: branch.branchId,
          expectedGeneration: read.branch.generation,
          roomDocument: room,
          updateData: update,
        }),
      );
      room.destroy();
      const after = await harness.readBranch(branch.branchId);
      observe("archive paused before commit", { archived: archivedBefore });
      observe("ensure held off", waiting);
      observe("after archive", {
        lifecycle: branch.lifecycle,
        frame: frame.ok ? frame.value : { refused: frame.name },
        durable: after,
      });
      assert.equal(archivedBefore, false);
      assert.equal(branch.lifecycle, "archived");
      assert.ok(!frame.ok || !frame.value.admitted, "the frame must be refused");
      assert.equal(after.revision, 0);
      assert.doesNotMatch(after.text, /AFTER ARCHIVE/);
      assert.ok(Y.encodeStateVector(live).length > 0);
    } finally {
      finish.open();
      live.destroy();
    }
  },
};
