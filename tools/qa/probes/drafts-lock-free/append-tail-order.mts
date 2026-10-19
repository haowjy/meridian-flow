/**
 * Phase 4 (design §1 "tail order", §9): journal ids are allocated after the draft row lock and
 * the lock is held to `COMMIT`, so a fold's `checkpoint_seq = max(id)` under `FOR UPDATE` is a
 * complete prefix. The append drops its revision predicate; this is what keeps the fold exact.
 *
 * - Arm 1: process A's frame holds at `draft.append.beforeCommit` (rows inserted, row held);
 *   process B's live pull waits on A's row (`pg_stat_activity`); after A commits, the pull's
 *   checkpoint covers A's id, the tail is empty and A's token is materialized.
 * - Arm 2 (negative control, raw SQL): a low-id `INSERT` with no row lock held open while a
 *   higher row commits and a fold runs; the fold waits only on the insert's FK lock, its
 *   checkpoint passes the low id, and the low row vanishes from materialization. The hazard
 *   exists without the row lock; arm 1 shows the lock prevents it.
 */
import assert from "node:assert/strict";
import { materializeDraftRead } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import {
  appendToFirstParagraph,
  gate,
  independently,
  observe,
  openHarness,
  type Probe,
  Y,
} from "./harness.mts";
import {
  draftRow,
  durableDoc,
  frameOutcome,
  journalRows,
  keystroke,
  nth,
  openProcess,
  pauseAt,
  runArms,
  seedDraft,
  tabOn,
} from "./phase4.mts";

export const appendTailOrder: Probe = {
  name: "append-tail-order",
  decision: "D28 (§1 tail order)",
  expected:
    "arm 1: the pull waits on A's row, then checkpoint_seq >= A's id, tail 0, A's token durable; arm 2: the unlocked low row falls below checkpoint_seq and vanishes",
  async run(harness) {
    await runArms({
      async "1-fold-waits-for-the-held-append"() {
        const draft = await seedDraft(harness, "tail-order");
        const other = await openHarness(harness.url);
        const a = await openProcess(harness, draft);
        const b = await openProcess(other, draft);
        // A first key, so the held one flips no review membership on today's code.
        const warm = keystroke(a.room, " warm", 930_000);
        await a.coordinator.commitWriterUpdate({
          draftId: draft.draftId,
          expectedGeneration: draft.generation,
          updateData: warm,
          roomDocument: a.room,
        });
        Y.applyUpdate(a.room, warm);
        const pause = pauseAt("draft.append.beforeCommit");
        try {
          const frame = independently(() =>
            frameOutcome(
              a.coordinator.commitWriterUpdate({
                draftId: draft.draftId,
                expectedGeneration: draft.generation,
                updateData: keystroke(a.room, " HELD", 930_001),
                roomDocument: a.room,
              }),
            ),
          );
          await pause.entered;
          appendToFirstParagraph(draft.live, " LIVE");
          const pull = independently(() =>
            b.coordinator.pullFromDoc({ draftId: draft.draftId, upstream: draft.live }),
          );
          const waiting = await harness.waitForLockWaiter(/document_drafts/);
          pause.release();
          const outcome = await frame;
          const pulled = await pull;
          const row = await draftRow(harness, draft.draftId);
          const durable = await harness.readDraft(draft.draftId);
          const aId = nth(await journalRows(harness, draft.draftId), -1).id;
          observe("arm 1", {
            waiting,
            outcome,
            pulled,
            aId,
            checkpointSeq: row.checkpointSeq,
            tail: durable.tail,
            text: durable.text,
          });
          assert.equal(outcome, "appended");
          assert.equal(pulled, "pulled");
          assert.ok(row.checkpointSeq >= aId, "the fold's checkpoint covers A's row");
          assert.equal(durable.tail, 0);
          assert.match(durable.text, / HELD/);
          assert.match(durable.text, / LIVE/);
        } finally {
          pause.remove();
          a.room.destroy();
          b.room.destroy();
          draft.live.destroy();
          await other.close();
        }
      },

      async "2-unlocked-insert-hazard"() {
        const draft = await seedDraft(harness, "tail-hazard");
        const { draftId, generation } = draft;
        const low = appendToFirstParagraph(tabOn(draft.live, 940_001), " LOW");
        const high = appendToFirstParagraph(tabOn(draft.live, 940_002), " HIGH");
        const inserted = gate();
        const finish = gate();
        let lowId = 0;
        // The unsequenced writer: an INSERT with no draft row lock, held open.
        const lowWriter = harness.raw.begin(async (tx) => {
          const [row] =
            await tx`insert into draft_write_journal (draft_id, generation, update_data, source, draft_base_update_seq)
            values (${draftId}, ${generation}, ${Buffer.from(low)}, 'writer', 0) returning id`;
          lowId = Number(row?.id);
          inserted.open();
          await finish.wait;
        });
        try {
          await inserted.wait;
          let highId = 0;
          await harness.raw.begin(async (tx) => {
            await tx`update document_drafts set revision = revision + 1 where id = ${draftId}`;
            const [row] =
              await tx`insert into draft_write_journal (draft_id, generation, update_data, source, draft_base_update_seq)
              values (${draftId}, ${generation}, ${Buffer.from(high)}, 'writer', 0) returning id`;
            highId = Number(row?.id);
          });
          const read = await harness.store.readDraftAt(draftId);
          if (!read) throw new Error("draft missing");
          const doc = materializeDraftRead(read);
          const fold = independently(() =>
            harness.store.commitRewrite({
              draftId,
              doc,
              policy: {
                kind: "fold",
                checkpointRevision: read.documentDraft.checkpointRevision,
                seq: highId,
              },

              operation: { kind: "compact" },
            }),
          );
          const waiting = await harness.waitForLockWaiter(/document_drafts/);
          finish.open();
          await lowWriter;
          const folded = await fold;
          doc.destroy();
          const after = await durableDoc(harness, draftId);
          const text = after.getXmlFragment("prosemirror").toString();
          after.destroy();
          const seq = folded.status === "committed" ? folded.seq : -1;
          observe("arm 2", { lowId, highId, waiting, folded, text });
          assert.ok(lowId < highId);
          assert.equal(folded.status, "committed");
          assert.ok(lowId < seq, "the fold's cursor passed the unsequenced row");
          assert.doesNotMatch(
            text,
            / LOW/,
            "and the row vanished: the hazard the row lock prevents",
          );
          assert.match(text, / HIGH/);
        } finally {
          finish.open();
          await lowWriter.catch(() => {});
          draft.live.destroy();
        }
      },
    });
  },
};
