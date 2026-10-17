/**
 * Decision D19: an archived Work's draft is frozen to content-moving rewrites. A live→draft pull
 * into it answers `inactive` and writes nothing (no revision, no text); after unarchive the next
 * pull lands.
 */
import assert from "node:assert/strict";
import { appendToFirstParagraph, observe, type Probe } from "./harness.mts";

export const d19ArchivedPull: Probe = {
  name: "d19-archived-pull",
  decision: "D19",
  expected: "archived: `inactive` with revision and text unchanged; unarchived: `pulled`",
  async run(harness) {
    const { workId, draftId } = await harness.seedWork("archived-pull");
    const { documentId, live } = await harness.seedDocument("archived-pull", "Base");
    const branch = await harness.store.ensureDraftBranch({ documentId, draftId, liveDoc: live });
    await harness.works.archive(workId);
    appendToFirstParagraph(live, " AFTER ARCHIVE");
    try {
      const before = await harness.readBranch(branch.branchId);
      const archived = await harness.coordinator.pullFromDoc({
        branchId: branch.branchId,
        upstream: live,
      });
      const after = await harness.readBranch(branch.branchId);
      observe("archived", { before, outcome: archived, after });
      assert.equal(before.lifecycle, "archived");
      assert.equal(archived, "inactive");
      assert.equal(after.revision, before.revision);
      assert.equal(after.text, before.text);

      await harness.works.unarchive(workId);
      const unarchived = await harness.coordinator.pullFromDoc({
        branchId: branch.branchId,
        upstream: live,
      });
      const caughtUp = await harness.readBranch(branch.branchId);
      observe("unarchived", { outcome: unarchived, after: caughtUp });
      assert.equal(unarchived, "pulled");
      assert.match(caughtUp.text, /AFTER ARCHIVE/);
    } finally {
      live.destroy();
    }
  },
};
