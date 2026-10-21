/**
 * Decision D12: every structural draft write takes Work, then branch, then draft, the order
 * Archive takes. A live→draft pull holds its Work row through its commit; an Archive that
 * starts meanwhile waits on that row rather than deadlocking against the draft row the pull
 * also holds, and then commits its lifecycle transition. The archived draft keeps pulling
 * (D23).
 */
import assert from "node:assert/strict";
import { setTestHook } from "../../../../apps/server/server/shared/test-hooks.ts";
import {
  appendToFirstParagraph,
  gate,
  independently,
  observe,
  type Probe,
  settled,
} from "./harness.mts";

export const d12PullBeforeArchive: Probe = {
  name: "d12-pull-before-archive",
  decision: "D12",
  expected:
    "Archive waits on the Work row the paused pull holds; both commit; the next pull is `pulled`",
  async run(harness) {
    const { workId, branchId } = await harness.seedWork("pull-archive");
    const { documentId, live } = await harness.seedDocument("pull-archive", "Base");
    const documentDraft = await harness.store.ensureDocumentDraft({
      documentId,
      branchId,
      liveDoc: live,
    });
    appendToFirstParagraph(live, " pulled");
    const paused = gate();
    const resume = gate();
    let first = true;
    const remove = setTestHook("draft.rewrite.beforeCommit", async () => {
      if (!first) return;
      first = false;
      paused.open();
      await resume.wait;
    });
    try {
      const pull = settled(
        harness.coordinator.pullFromDoc({ draftId: documentDraft.draftId, upstream: live }),
      );
      await paused.wait;
      const archive = settled(independently(() => harness.works.archive(workId)));
      const waiting = await harness.waitForLockWaiter(/works/);
      resume.open();
      const pulled = await pull;
      const archived = await archive;
      const after = await harness.readDraft(documentDraft.draftId);
      const next = await harness.coordinator.pullFromDoc({
        draftId: documentDraft.draftId,
        upstream: live,
      });
      observe("archive held off", waiting);
      observe("outcomes", {
        pull: pulled.ok ? pulled.value : pulled,
        archive: archived.ok,
        after,
        nextPull: next,
      });
      assert.deepEqual(pulled, { ok: true, value: "pulled" });
      assert.equal(archived.ok, true);
      assert.equal(after.lifecycle, "archived");
      assert.match(after.text, /Base pulled/);
      assert.equal(next, "pulled");
    } finally {
      resume.open();
      remove();
      live.destroy();
    }
  },
};
