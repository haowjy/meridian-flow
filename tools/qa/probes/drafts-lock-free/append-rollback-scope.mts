/**
 * Phase 4 (design §2.6, R4): an append's outcome that must not stand (contained, prefix-missing)
 * rolls back exactly its own savepoint: the revision bump and its inserts, never the caller's
 * earlier writes, and fires no dirty mark (`onAppendCommitted`, §3.1).
 *
 * (a) a contained frame at the root: an exact resend that reaches the row lock behind the
 *     original's commit; (b) the same resend inside an ambient transaction that wrote an
 *     unrelated row first; (c) a prefix-missing frame inside the same.
 *
 * Negative control on `586e58ae1e`: (c) journals the dependent delete inside the ambient
 * transaction; (a) and (b) fire no dirty mark because the coordinator has none.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import {
  appendToFirstParagraph,
  type Harness,
  independently,
  observe,
  type Probe,
} from "./harness.mts";
import {
  captureUpdate,
  firstText,
  frameOutcome,
  journalRows,
  keystroke,
  openRoom,
  pauseAt,
  phase4Coordinator,
  runArms,
  seedDraft,
  tabOn,
} from "./phase4.mts";

/** An unrelated write the caller's transaction made before the append: the Work's name. */
async function renameWork(harness: Harness, workId: string, name: string) {
  await currentDrizzleDb(harness.db).execute(
    sql`update works set name = ${name} where id = ${workId}`,
  );
}

async function workName(harness: Harness, workId: string) {
  const [row] = await harness.raw<{ name: string }[]>`select name from works where id = ${workId}`;
  return row?.name;
}

export const appendRollbackScope: Probe = {
  name: "append-rollback-scope",
  decision: "D28 (§2.6 R4)",
  expected:
    "a contained or prefix-missing append keeps the revision, writes no row and fires no dirty mark; an ambient transaction's earlier write commits",
  async run(harness) {
    const dirty: string[] = [];
    const coordinator = phase4Coordinator(harness, { onAppendCommitted: (id) => dirty.push(id) });

    /** U1 held at `beforeCommit`; `resend` runs while it holds the row; then U1 commits. */
    async function overlappingResend(
      label: string,
      resend: (send: () => Promise<unknown>, workId: string) => Promise<unknown>,
    ) {
      const draft = await seedDraft(harness, label);
      const tab = await openRoom(harness, coordinator, draft);
      // A first key, so U1 flips no review membership on today's code (no Work lock).
      assert.equal(await tab.send(keystroke(tab.room, " warm")), "appended");
      const u1 = keystroke(tab.room, "A", 900_101);
      const before = (await harness.readDraft(draft.draftId)).revision;
      dirty.length = 0;
      const pause = pauseAt("branch.append.beforeCommit");
      try {
        const first = independently(() => tab.send(u1));
        await pause.entered;
        const second = independently(() => resend(() => tab.send(u1), draft.workId));
        const waiting = await harness.waitForLockWaiter(/document_drafts|works/);
        pause.release();
        const outcomes = [await first, await second];
        const after = await harness.readDraft(draft.draftId);
        const rows = await journalRows(harness, draft.draftId);
        return { draft, waiting, outcomes, before, after, rows: rows.length, dirty: [...dirty] };
      } finally {
        pause.remove();
        tab.room.destroy();
        draft.live.destroy();
      }
    }

    await runArms({
      async "a-contained-at-root"() {
        const r = await overlappingResend("rollback-a", (send) => send());
        observe("a", {
          outcomes: r.outcomes,
          revision: [r.before, r.after.revision],
          rows: r.rows,
          dirty: r.dirty.length,
        });
        assert.deepEqual(r.outcomes, ["appended", "contained"]);
        assert.equal(r.after.revision, r.before + 1, "the contained resend's bump rolled back");
        assert.equal(r.rows, 2, "the warm-up key and U1");
        assert.equal(r.dirty.length, 1, "one dirty mark: U1's");
      },

      async "b-contained-inside-ambient-transaction"() {
        const r = await overlappingResend("rollback-b", (send, workId) =>
          runInDrizzleTransaction(harness.db, async () => {
            await renameWork(harness, workId, "earlier write in the response");
            return send();
          }),
        );
        const name = await workName(harness, r.draft.workId);
        observe("b", {
          outcomes: r.outcomes,
          name,
          revision: [r.before, r.after.revision],
          rows: r.rows,
          dirty: r.dirty.length,
        });
        assert.deepEqual(r.outcomes, ["appended", "contained"]);
        assert.equal(name, "earlier write in the response", "the ambient transaction committed");
        assert.equal(r.after.revision, r.before + 1);
        assert.equal(r.rows, 2);
        assert.equal(r.dirty.length, 1);
      },

      async "c-prefix-missing-inside-ambient-transaction"() {
        const draft = await seedDraft(harness, "rollback-c");
        const tab = await openRoom(harness, coordinator, draft);
        const writer = tabOn(draft.live, 900_102);
        try {
          appendToFirstParagraph(writer, "W");
          const dependent = captureUpdate(writer, () => {
            const t = firstText(writer);
            t.delete(t.length - 1, 1);
          });
          const before = (await harness.readDraft(draft.draftId)).revision;
          dirty.length = 0;
          let outcome: unknown;
          const root = await frameOutcome(
            runInDrizzleTransaction(harness.db, async () => {
              await renameWork(harness, draft.workId, "earlier write before a gap");
              outcome = await tab.send(dependent);
              return { admitted: true };
            }),
          );
          const after = (await harness.readDraft(draft.draftId)).revision;
          const rows = (await journalRows(harness, draft.draftId)).length;
          const name = await workName(harness, draft.workId);
          observe("c", {
            outcome,
            root,
            revision: [before, after],
            rows,
            name,
            dirty: dirty.length,
          });
          assert.equal(outcome, "prefixMissing");
          assert.equal(root, "appended", "the ambient transaction committed");
          assert.equal(name, "earlier write before a gap");
          assert.equal(after, before);
          assert.equal(rows, 0);
          assert.equal(dirty.length, 0);
        } finally {
          writer.destroy();
          tab.room.destroy();
          draft.live.destroy();
        }
      },
    });
  },
};
