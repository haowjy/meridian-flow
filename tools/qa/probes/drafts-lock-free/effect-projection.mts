/**
 * Phase 4 (design §3.1–3.4, F3/F4): a keystroke's append and the branch's derived state are two
 * events. The append marks its branch dirty; the projection job judges `has_effect` against the
 * stored baseline 250 ms after the last key (at most 1 s after the first unserved one), writes it
 * with its watermark, and touches the Work once per run. No keystroke locks or counts a Work.
 *
 * Arms, each on its own draft (the Works badge is `countPendingByWorkIds`, the Work's
 * republication is its `entity_revision`):
 * 1. one key into a fresh draft: pending 1 and the Work republished within 1 s;
 * 2. 3 s of keys at 50 ms: pending within 1 s of the first key, at most four touches;
 *    then deleting everything typed: pending 0 within 1 s;
 * 3. Apply staging (rows `pushed`, `has_effect` still true) then one key: the Work republishes
 *    within 1 s (the review's `row-only-membership-flip`);
 * 4. two processes typing inside one debounce: the stored value equals the materialized
 *    comparison and `has_effect_revision = revision`.
 *
 * Negative control on `586e58ae1e`: there is no watermark and no job, so arm 4 fails on the
 * watermark; arms 1–3 report today's inline effect for comparison.
 */
import assert from "node:assert/strict";
import { independently, observe, openHarness, type Probe } from "./harness.mts";
import {
  branchRow,
  captureUpdate,
  firstText,
  judgedEffect,
  keystroke,
  openProjected,
  openRoom,
  runArms,
  seedDraft,
  within,
  workBadge,
} from "./phase4.mts";

const KEY_MS = 50;
const TYPING_MS = 3_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const effectProjection: Probe = {
  name: "effect-projection",
  decision: "D28 (§3 F3/F4)",
  expected:
    "badge follows a key within 1 s, continuous typing within 1 s of the first key with at most four touches, delete-all clears within 1 s, a key after staging republishes the Work, two processes converge with a fresh watermark",
  async run(harness) {
    const p = await openProjected(harness);
    if (p.missing) observe("projection", p.missing);
    try {
      await runArms({
        async "1-one-key"() {
          const draft = await seedDraft(harness, "effect-one-key");
          const tab = await openRoom(harness, p.coordinator, draft);
          try {
            const before = await workBadge(harness, draft.workId);
            assert.equal(await tab.send(keystroke(tab.room, " key")), "appended");
            const caught = await within(
              1_000,
              () => workBadge(harness, draft.workId),
              (b) => b.pending === 1 && b.entityRevision > before.entityRevision,
            );
            const row = await branchRow(harness, draft.branchId);
            observe("arm 1", {
              before,
              ...caught,
              watermark: row.watermark,
              revision: row.revision,
            });
            assert.equal(row.watermark, row.revision, "the judgement carries its watermark");
          } finally {
            tab.room.destroy();
            draft.live.destroy();
          }
        },

        async "2-continuous-typing-then-delete-all"() {
          const draft = await seedDraft(harness, "effect-typing");
          const tab = await openRoom(harness, p.coordinator, draft);
          try {
            const before = await workBadge(harness, draft.workId);
            const started = performance.now();
            let firstPendingMs: number | null = null;
            const typing = (async () => {
              while (performance.now() - started < TYPING_MS) {
                assert.equal(await tab.send(keystroke(tab.room, "x")), "appended");
                await pause(KEY_MS);
              }
            })();
            while (performance.now() - started < TYPING_MS) {
              if (firstPendingMs === null && (await workBadge(harness, draft.workId)).pending === 1)
                firstPendingMs = Math.round(performance.now() - started);
              await pause(10);
            }
            await typing;
            const typed = await within(
              1_000,
              () => branchRow(harness, draft.branchId),
              (row) => row.watermark === row.revision,
            );
            const touches =
              (await workBadge(harness, draft.workId)).entityRevision - before.entityRevision;
            const text = firstText(tab.room);
            const typedChars = text.length - "Base".length;
            const erase = captureUpdate(tab.room, () => text.delete("Base".length, typedChars));
            const erased = await tab.send(erase);
            const cleared = await within(
              1_000,
              () => workBadge(harness, draft.workId),
              (b) => b.pending === 0,
            );
            observe("arm 2", {
              firstPendingMs,
              touches,
              typedChars,
              settledMs: typed.elapsedMs,
              erased,
              clearedMs: cleared.elapsedMs,
            });
            assert.ok(
              firstPendingMs !== null && firstPendingMs <= 1_000,
              "pending within 1 s of the first key",
            );
            assert.ok(touches <= 4, `at most four Work touches while typing, saw ${touches}`);
            assert.equal(erased, "appended");
          } finally {
            tab.room.destroy();
            draft.live.destroy();
          }
        },

        async "3-key-after-apply-staging"() {
          const draft = await seedDraft(harness, "effect-staged");
          const tab = await openRoom(harness, p.coordinator, draft);
          try {
            assert.equal(await tab.send(keystroke(tab.room, " staged")), "appended");
            await within(
              1_000,
              () => workBadge(harness, draft.workId),
              (b) => b.pending === 1,
            );
            // Apply staging's effect on the branch: every row pushed under a revision bump,
            // `has_effect` untouched (an exact rewrite, `drizzle-branch-push.ts`).
            await harness.raw.begin(async (tx) => {
              await tx`update branch_write_journal set status = 'pushed', pushed_at = now() where branch_id = ${draft.branchId}`;
              await tx`update document_branches set revision = revision + 1 where id = ${draft.branchId}`;
            });
            const staged = await workBadge(harness, draft.workId);
            assert.equal(await tab.send(keystroke(tab.room, " after")), "appended");
            const caught = await within(
              1_000,
              () => workBadge(harness, draft.workId),
              (b) => b.pending === 1 && b.entityRevision > staged.entityRevision,
            );
            observe("arm 3", { staged, ...caught });
          } finally {
            tab.room.destroy();
            draft.live.destroy();
          }
        },

        async "4-two-processes-one-debounce"() {
          const draft = await seedDraft(harness, "effect-two-process");
          const other = await openHarness(harness.url);
          const q = await openProjected(other);
          const a = await openRoom(harness, p.coordinator, draft);
          const b = await openRoom(other, q.coordinator, draft);
          try {
            const sent = await Promise.all([
              independently(() => a.send(keystroke(a.room, " A", 960_001))),
              independently(() => b.send(keystroke(b.room, " B", 960_002))),
            ]);
            const settledRow = await within(
              2_000,
              () => branchRow(harness, draft.branchId),
              (row) => row.watermark === row.revision,
            );
            const judged = await judgedEffect(harness, draft.branchId);
            observe("arm 4", {
              sent,
              row: settledRow.observation,
              judged,
              settledMs: settledRow.elapsedMs,
            });
            assert.deepEqual(sent, ["appended", "appended"]);
            assert.equal(settledRow.observation.hasEffect, judged);
          } finally {
            q.dispose();
            a.room.destroy();
            b.room.destroy();
            draft.live.destroy();
            await other.close();
          }
        },
      });
    } finally {
      p.dispose();
    }
  },
};
