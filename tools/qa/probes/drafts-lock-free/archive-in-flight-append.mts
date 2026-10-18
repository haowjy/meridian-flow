/**
 * Phase 4 (design §5, F6, D30 Q3): Archive locks no branch row; the append keeps the Work
 * predicate in its `UPDATE` and rechecks the lifecycle in its post-lock read. What remains is
 * the honest window: a key whose post-lock read ran before Archive committed may land in the
 * archived draft; every later key is refused.
 *
 * - Arm 1 (holder): a frame holds at `branch.append.beforeCommit` while Archive commits; the
 *   row commits, the text holds the token under `archived`, the next frame is refused, and
 *   after unarchive the next frame lands with the token kept.
 * - Arm 2 (queued waiter): a second frame waits on the first's row when Archive commits; after
 *   it takes the lock, its post-lock read sees `archived` and it writes nothing.
 * - Arm 3: a frame started after Archive is refused by the predicate.
 *
 * Each arm types one key first, so the measured keys flip no review membership on today's code.
 * Negative control on `586e58ae1e`: Archive's `fenceWorkBranches` waits on the held row (arms
 * 1 and 2 report the wait instead of an Archive that committed).
 */
import assert from "node:assert/strict";
import { independently, observe, type Probe, settled } from "./harness.mts";
import {
  journalRows,
  keystroke,
  openRoom,
  pauseAt,
  phase4Coordinator,
  runArms,
  seedDraft,
  settledOrWaiting,
} from "./phase4.mts";

export const archiveInFlightAppend: Probe = {
  name: "archive-in-flight-append",
  decision: "D30 Q3 (§5 F6)",
  expected:
    "arm 1: Archive commits while the frame holds its row, the key lands archived, the next is refused, unarchive admits; arm 2: the queued key is refused with zero rows; arm 3: refused",
  async run(harness) {
    const coordinator = phase4Coordinator(harness);

    async function draftWithOneKey(label: string) {
      const draft = await seedDraft(harness, label);
      const tab = await openRoom(harness, coordinator, draft);
      assert.equal(await tab.send(keystroke(tab.room, " warm")), "appended");
      return { draft, tab };
    }

    /** Archive on its own connection, while something holds the branch row. */
    async function archiveWhileHeld(workId: string) {
      const archive = settled(independently(() => harness.works.archive(workId as never)));
      const observed = await settledOrWaiting(harness, archive, /document_branches/);
      return { archive, observed };
    }

    await runArms({
      async "1-holder"() {
        const { draft, tab } = await draftWithOneKey("archive-holder");
        const pause = pauseAt("branch.append.beforeCommit");
        try {
          const frame = independently(() => tab.send(keystroke(tab.room, " TOKEN")));
          await pause.entered;
          const { archive, observed } = await archiveWhileHeld(draft.workId);
          pause.release();
          const outcome = await frame;
          const archived = await archive;
          const held = await harness.readBranch(draft.branchId);
          const next = await tab.send(keystroke(tab.room, " REFUSED"));
          await harness.works.unarchive(draft.workId);
          const after = await tab.send(keystroke(tab.room, " AFTER"));
          const durable = await harness.readBranch(draft.branchId);
          observe("arm 1", {
            archiveWhileHeld: observed.settled ? "committed" : observed.waiting,
            archived: archived.ok,
            outcome,
            held: { lifecycle: held.lifecycle, text: held.text },
            next,
            after,
            durable: durable.text,
          });
          assert.equal(
            observed.settled,
            true,
            "Archive commits while the frame holds the branch row",
          );
          assert.equal(outcome, "appended");
          assert.equal(held.lifecycle, "archived");
          assert.match(held.text, / TOKEN/);
          assert.ok(typeof next === "object", "the next key is refused");
          assert.equal(after, "appended");
          assert.match(durable.text, / TOKEN/);
          assert.doesNotMatch(durable.text, / REFUSED/);
        } finally {
          pause.remove();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "2-queued-waiter"() {
        const { draft, tab } = await draftWithOneKey("archive-queued");
        const pause = pauseAt("branch.append.beforeCommit");
        try {
          const first = independently(() => tab.send(keystroke(tab.room, " FIRST", 950_001)));
          await pause.entered;
          const queued = independently(() => tab.send(keystroke(tab.room, " QUEUED", 950_002)));
          const queuedWait = await harness.waitForLockWaiter(/document_branches/);
          const { archive, observed } = await archiveWhileHeld(draft.workId);
          pause.release();
          const outcomes = [await first, await queued];
          await archive;
          const rows = await journalRows(harness, draft.branchId);
          const durable = await harness.readBranch(draft.branchId);
          observe("arm 2", {
            queuedWait,
            archiveWhileHeld: observed.settled ? "committed" : observed.waiting,
            outcomes,
            rows: rows.length,
            text: durable.text,
          });
          assert.equal(observed.settled, true, "Archive commits while a key waits on the row");
          assert.equal(outcomes[0], "appended");
          assert.ok(typeof outcomes[1] === "object", "the queued key is refused");
          assert.equal(rows.length, 2, "the warm-up key and FIRST");
          assert.doesNotMatch(durable.text, / QUEUED/);
        } finally {
          pause.remove();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "3-started-after-archive"() {
        const { draft, tab } = await draftWithOneKey("archive-after");
        try {
          await harness.works.archive(draft.workId);
          const outcome = await tab.send(keystroke(tab.room, " LATE"));
          const rows = await journalRows(harness, draft.branchId);
          observe("arm 3", { outcome, rows: rows.length });
          assert.ok(typeof outcome === "object", "refused");
          assert.equal(rows.length, 1);
        } finally {
          tab.room.destroy();
          draft.live.destroy();
        }
      },
    });
  },
};
