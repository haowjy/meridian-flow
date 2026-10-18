/**
 * Phase 4 (design §3.1–3.4, F3/F4): a keystroke's append and the branch's derived state are two
 * events. The append marks its branch dirty; the projection job judges `has_effect` against the
 * stored baseline 250 ms after the last key (at most 1 s after the first unserved one), writes it
 * with its watermark, and reconciles the Work's stored pending count, bumping its revision only
 * when the count moved (W47, D41); a write a key overtook re-judges at once. No keystroke locks
 * or counts a Work. The badge converges within the max wait once typing pauses and eventually
 * while typing (D34).
 *
 * Arms, each on its own draft (the Works badge is the Work's stored `pending_document_count`,
 * its notice is its `entity_revision`):
 * 1. one key into a fresh draft: pending 1 and the Work's revision moved within 1 s;
 * 2. 3 s of keys at 50 ms: pending within the 1 s max wait after the typing pauses, and exactly
 *    one revision for the one count change, however many effect runs; the time to the first
 *    pending while typing is reported, not asserted; then deleting everything typed: pending 0
 *    within 1 s;
 * 3. Apply staging (rows `pushed`, `has_effect` still true, through `mutate` as staging takes
 *    it) then one key: the count was stored 0 and the append moved it outside `mutate`, so the
 *    effect run, comparing against the stored value, bumps the revision within 1 s (the review's
 *    `row-only-membership-flip`; a before/after count would see 1 → 1 and stay silent);
 * 4. two processes typing inside one debounce: the stored value equals the materialized
 *    comparison and `has_effect_revision = revision`.
 *
 * Negative control on `586e58ae1e` (inline effect, no job, no watermark): arms 1, 2 and 4 fail
 * on the watermark; arm 3 passed there through the inline membership flip.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import { independently, observe, openHarness, type Probe } from "./harness.mts";
import {
  branchRow,
  captureUpdate,
  countingEffects,
  firstText,
  judgedEffect,
  keystroke,
  openProjected,
  openRoom,
  percentiles,
  runArms,
  seedDraft,
  within,
  workBadge,
} from "./phase4.mts";

const KEY_MS = 50;
/** The badge's bound once typing pauses (D34). */
const MAX_WAIT_MS = 1_000;
const TYPING_MS = 3_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const effectProjection: Probe = {
  name: "effect-projection",
  decision: "D28 (§3 F3/F4)",
  expected:
    "badge follows a key within 1 s, continuous typing within 1 s of the pause with one revision for one count change, delete-all clears within 1 s, a key after staging moves the Work's revision, two processes converge with a fresh watermark",
  async run(harness) {
    const p = await openProjected(harness);
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
          const effects = countingEffects(harness.store);
          const typingProcess = await openProjected(harness, { store: effects.store });
          const tab = await openRoom(harness, typingProcess.coordinator, draft);
          try {
            const before = await workBadge(harness, draft.workId);
            const started = performance.now();
            let firstPendingMs: number | null = null;
            const keyMs: number[] = [];
            const typing = (async () => {
              while (performance.now() - started < TYPING_MS) {
                const sent = performance.now();
                assert.equal(await tab.send(keystroke(tab.room, "x")), "appended");
                keyMs.push(performance.now() - sent);
                await pause(KEY_MS);
              }
            })();
            while (performance.now() - started < TYPING_MS) {
              if (firstPendingMs === null && (await workBadge(harness, draft.workId)).pending === 1)
                firstPendingMs = Math.round(performance.now() - started);
              await pause(10);
            }
            await typing;
            const paused = await within(
              MAX_WAIT_MS,
              () => workBadge(harness, draft.workId),
              (b) => b.pending === 1,
            );
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
            const appends = harness.appends.filter((append) => append.branchId === draft.branchId);
            observe("arm 2", {
              keys: percentiles(keyMs),
              waitMs: percentiles(appends.map((append) => append.waitMs)),
              holdMs: percentiles(appends.map((append) => append.holdMs)),
              writeEffect: effects.outcomes,
              firstPendingMs,
              pendingAfterPauseMs: paused.elapsedMs,
              touches,
              typedChars,
              settledMs: typed.elapsedMs,
              erased,
              clearedMs: cleared.elapsedMs,
            });
            assert.equal(touches, 1, `one Work revision for one count change, saw ${touches}`);
            assert.equal(erased, "appended");
          } finally {
            typingProcess.dispose();
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
            // `has_effect` untouched (an exact rewrite, `drizzle-branch-push.ts`), inside the
            // Works boundary as `commitPushBatch` runs it.
            await harness.projection.mutate({ branches: [draft.branchId] }, async () => {
              const tx = currentDrizzleDb(harness.db);
              await tx.execute(
                sql`update branch_write_journal set status = 'pushed', pushed_at = now() where branch_id = ${draft.branchId}`,
              );
              await tx.execute(
                sql`update document_branches set revision = revision + 1 where id = ${draft.branchId}`,
              );
            });
            const staged = await workBadge(harness, draft.workId);
            assert.equal(staged.pending, 0, "staging reconciled the stored count");
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
