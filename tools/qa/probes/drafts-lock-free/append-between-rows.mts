/**
 * Phase 4 (design §2.1, §2.2, §2.4): an append takes the draft row with no revision predicate
 * and judges against what committed before it took the lock. Process A judges a key on revision
 * r and is held before its `appendRows`; process B, on its own connections, commits meanwhile;
 * A then appends once, with no retry.
 *
 * - Arm 1: B commits two frames. A's row lands at `r + 3`, its receipt's frontier holds B's
 *   clocks, A's room has B's rows from A's own install, and A's store saw one `appendRows`.
 * - Arm 2: B's pull moves the checkpoint. A's prefix is materialized under the lock; A's next
 *   read holds the pulled text and A's token.
 *
 * Negative control on `586e58ae1e`: A's append misses `revision = r` and the frame judges again
 * (two `appendRows` calls), which is the retry phase 4 deletes.
 */
import assert from "node:assert/strict";
import type { DraftStore } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import {
  appendToFirstParagraph,
  type Harness,
  independently,
  observe,
  openHarness,
  type Probe,
  Y,
} from "./harness.mts";
import {
  frameOutcome,
  journalRows,
  keystroke,
  nth,
  openProcess,
  pausedAppend,
  receipts,
  runArms,
  seedDraft,
} from "./phase4.mts";

const text = (doc: Y.Doc) => doc.getXmlFragment("prosemirror").toString();

/** `store` whose `appendRows` calls are counted: one per frame without a retry loop. */
function counted(store: DraftStore) {
  const calls = { appendRows: 0 };
  const wrapped: DraftStore = {
    ...store,
    appendRows(input) {
      calls.appendRows += 1;
      return store.appendRows(input);
    },
  };
  return { wrapped, calls };
}

async function send(
  process: Awaited<ReturnType<typeof openProcess>>,
  draft: { draftId: string },
  update: Uint8Array,
) {
  const outcome = await frameOutcome(
    process.coordinator.commitWriterUpdate({
      draftId: draft.draftId,
      updateData: update,
      roomDocument: process.room,
    }),
  );
  if (outcome === "appended") Y.applyUpdate(process.room, update, "client");
  return outcome;
}

async function twoProcesses(harness: Harness, label: string) {
  const draft = await seedDraft(harness, label);
  const count = counted(harness.store);
  const pause = pausedAppend(count.wrapped);
  const other = await openHarness(harness.url);
  const a = await openProcess(harness, draft, pause.paused);
  const b = await openProcess(other, draft);
  return { draft, count, pause, other, a, b };
}

export const appendBetweenRows: Probe = {
  name: "append-between-rows",
  decision: "D28 (§2.1–2.4)",
  expected:
    "arm 1: A appended once at r+3 with B's clocks in its frontier and B's rows in its room; arm 2: A appended once over B's pull, next read holds LIVE and A's token",
  async run(harness) {
    await runArms({
      async "1-two-frames-between"() {
        const f = await twoProcesses(harness, "between-rows");
        try {
          const r = (await harness.readDraft(f.draft.draftId)).revision;
          const key = keystroke(f.a.room, " A1", 910_001);
          const frame = independently(() => send(f.a, f.draft, key));
          await f.pause.entered;
          const bOutcomes = [
            await send(f.b, f.draft, keystroke(f.b.room, " B1", 920_001)),
            await send(f.b, f.draft, keystroke(f.b.room, " B2", 920_002)),
          ];
          f.pause.release();
          const outcome = await frame;
          const roomAfterInstall = text(f.a.room);
          const durable = await harness.readDraft(f.draft.draftId);
          const rows = await journalRows(harness, f.draft.draftId);
          const aRow = nth(rows, -1);
          const aReceipt = (await receipts(harness, f.draft.draftId)).find(
            (parts) => parts[0]?.rowId === aRow.id,
          );
          const frontier = aReceipt?.[0]?.frontier ?? {};
          observe("arm 1", {
            bOutcomes,
            outcome,
            appendRowsCalls: f.count.calls.appendRows,
            revision: [r, durable.revision],
            roomAfterInstall,
            frontier,
          });
          assert.deepEqual(bOutcomes, ["appended", "appended"]);
          assert.equal(outcome, "appended");
          assert.equal(f.count.calls.appendRows, 1, "one sequence point, no retry");
          assert.equal(durable.revision, r + 3);
          assert.match(roomAfterInstall, / B1/);
          assert.match(roomAfterInstall, / B2/);
          assert.equal(frontier["920001"], 3, "the receipt was captured on a prefix holding B1");
          assert.equal(frontier["920002"], 3, "and B2");
          assert.match(durable.text, / A1/);
        } finally {
          f.pause.release();
          f.draft.live.destroy();
          f.a.room.destroy();
          f.b.room.destroy();
          await f.other.close();
        }
      },

      async "2-pull-moves-the-checkpoint"() {
        const f = await twoProcesses(harness, "between-pull");
        try {
          const key = keystroke(f.a.room, " A1", 910_002);
          const frame = independently(() => send(f.a, f.draft, key));
          await f.pause.entered;
          appendToFirstParagraph(f.draft.live, " LIVE");
          const pulled = await f.b.coordinator.pullFromDoc({
            draftId: f.draft.draftId,
            upstream: f.draft.live,
          });
          const movedTo = await harness.readDraft(f.draft.draftId);
          f.pause.release();
          const outcome = await frame;
          const nextRead = await f.a.coordinator.readDraft(f.draft.draftId, async (doc) =>
            text(doc),
          );
          const durable = await harness.readDraft(f.draft.draftId);
          observe("arm 2", {
            pulled,
            checkpointRevision: movedTo.checkpointRevision,
            outcome,
            appendRowsCalls: f.count.calls.appendRows,
            nextRead,
            durable: durable.text,
          });
          assert.equal(pulled, "pulled");
          assert.equal(outcome, "appended");
          assert.equal(f.count.calls.appendRows, 1, "one sequence point, no retry");
          for (const doc of [nextRead, durable.text]) {
            assert.match(doc, /LIVE/);
            assert.match(doc, / A1/);
          }
        } finally {
          f.pause.release();
          f.draft.live.destroy();
          f.a.room.destroy();
          f.b.room.destroy();
          await f.other.close();
        }
      },
    });
  },
};
