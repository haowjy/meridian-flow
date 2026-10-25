/**
 * Phase 4 (design §3.2 sweep, R5/R6/G5/G6, review C1): the watermark
 * `has_effect_revision` says which judgements are stale, and a finite keyset sweep repairs them.
 *
 * (a) a key committed with no projection job leaves the watermark behind and the badge stale;
 *     a fresh process's `sweep()` repairs both.
 * (b) a compaction leaves the watermark behind; the sweep re-judges the same value.
 * (c) fairness: 51 stale drafts, the newest 50 on a Work an open transaction holds, the oldest
 *     on an idle Work. One pass tracks all 51 in two pages; the oldest is written within 2 s
 *     while the 50 answer `contended`; no projection connection waits on one lock longer than
 *     the 100 ms `lock_timeout` (per lock acquisition, C1); the next tick is a new pass;
 *     releasing the Work lets the 50 land on their backoff.
 * (c) first marks every other draft fresh, so the sweep sees only its rows.
 * Negative control on `586e58ae1e`: there is no watermark column, no job and no store door.
 */
import assert from "node:assert/strict";
import { observe, type Probe, type Y } from "./harness.mts";
import {
  draftRow,
  durableDoc,
  type EffectWrite,
  keystroke,
  openProjected,
  openRoom,
  phase4Coordinator,
  runArms,
  seedDraft,
  within,
  workBadge,
} from "./phase4.mts";

const LOCK_TIMEOUT_MS = 100;

export const effectWatermarkSweep: Probe = {
  name: "effect-watermark-sweep",
  decision: "D28 (§3.2–3.3 R5/R6/G5/G6)",
  expected:
    "(a) the sweep repairs an unprojected key; (b) a compaction's stale watermark is re-judged; (c) one fair pass of two pages, the idle Work's draft written within 2 s, no lock wait past 100 ms",
  async run(harness) {
    await runArms({
      async "a-unprojected-key"() {
        const draft = await seedDraft(harness, "sweep-unprojected");
        const quiet = phase4Coordinator(harness);
        const tab = await openRoom(harness, quiet, draft);
        const p = await openProjected(harness);
        try {
          assert.equal(await tab.send(keystroke(tab.room, " key")), "appended");
          const stale = await draftRow(harness, draft.draftId);
          const badge = await workBadge(harness, draft.workId);
          await p.projection().sweep();
          const repaired = await within(
            2_000,
            () => draftRow(harness, draft.draftId),
            (row) => row.watermark === row.revision,
          );
          const after = await workBadge(harness, draft.workId);
          observe("a", { stale, badge, repaired, after });
          assert.ok(
            stale.watermark !== null && stale.watermark < stale.revision,
            "the key left it stale",
          );
          assert.equal(badge.pending, 0, "the badge omits the unprojected draft");
          assert.equal(after.pending, 1);
          assert.equal(repaired.observation.hasEffect, true);
        } finally {
          p.dispose();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "b-compaction-leaves-it-behind"() {
        const draft = await seedDraft(harness, "sweep-compaction");
        const p = await openProjected(harness);
        const tab = await openRoom(harness, p.coordinator, draft);
        try {
          assert.equal(await tab.send(keystroke(tab.room, " key")), "appended");
          const fresh = await within(
            1_000,
            () => draftRow(harness, draft.draftId),
            (row) => row.watermark === row.revision,
          );
          const read = await harness.store.readDraftAt(draft.draftId);
          if (!read) throw new Error("draft missing");
          const checkpoint = await durableDoc(harness, draft.draftId);
          const compacted = await harness.store.commitRewrite({
            draftId: draft.draftId,
            doc: checkpoint,
            policy: {
              kind: "fold",
              checkpointRevision: read.documentDraft.checkpointRevision,
              seq: 0,
            },

            operation: { kind: "compact" },
          });
          checkpoint.destroy();
          const behind = await draftRow(harness, draft.draftId);
          await p.projection().sweep();
          const rejudged = await within(
            2_000,
            () => draftRow(harness, draft.draftId),
            (row) => row.watermark === row.revision,
          );
          observe("b", {
            fresh: fresh.observation,
            compacted: compacted.status,
            behind,
            rejudged: rejudged.observation,
          });
          assert.ok(behind.watermark !== null && behind.watermark < behind.revision);
          assert.equal(
            rejudged.observation.hasEffect,
            fresh.observation.hasEffect,
            "the same value",
          );
        } finally {
          p.dispose();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "c-fairness-under-a-held-work"() {
        await markEverythingFresh();
        const held = await harness.seedWork("sweep-held");
        const idle = await harness.seedWork("sweep-idle");
        const draftIds: string[] = [];
        const lives: Y.Doc[] = [];
        for (let index = 0; index < 51; index += 1) {
          const work = index === 0 ? idle : held;
          const { documentId, live } = await harness.seedDocument(`sweep-${index}`);
          lives.push(live);
          const documentDraft = await harness.store.ensureDocumentDraft({
            documentId,
            branchId: work.branchId,
            liveDoc: live,
            liveRoom: null,
          });
          draftIds.push(documentDraft.draftId);
        }
        // Stale, with the idle Work's draft the oldest: it is on the last page of the pass.
        for (const [index, id] of draftIds.entries())
          await harness.raw`update document_drafts set revision = revision + 1,
            updated_at = ${new Date(1_700_000_000_000 + index * 1_000)} where id = ${id}`;
        const [first, rest] = [draftIds[0] as string, draftIds.slice(1)];
        const pages: number[] = [];
        const outcomes: Record<EffectWrite, number> = { written: 0, moved: 0, contended: 0 };
        const store = harness.store;
        const counted = {
          ...store,
          async staleEffectDrafts(input: Parameters<typeof store.staleEffectDrafts>[0]) {
            const page = await store.staleEffectDrafts(input);
            pages.push(page.length);
            return page;
          },
          async writeEffect(input: Parameters<typeof store.writeEffect>[0]) {
            const outcome = await store.writeEffect(input);
            outcomes[outcome] += 1;
            return outcome;
          },
        };
        const holding = { release: () => {} };
        const holder = harness.raw.begin(async (tx) => {
          await tx`select id from works where id = ${held.workId} for no key update`;
          await new Promise<void>((resolve) => {
            holding.release = resolve;
          });
        });
        const p = await openProjected(harness, { store: counted });
        let maxWaitMs = 0;
        let sampling = true;
        const sampler = (async () => {
          while (sampling) {
            const [row] = await harness.raw<{ age: number | null }[]>`
              select max(extract(epoch from now() - query_start) * 1000)::float as age
              from pg_stat_activity
              where datname = current_database() and application_name = 'lfd-probe'
                and wait_event_type = 'Lock'`;
            maxWaitMs = Math.max(maxWaitMs, Math.round(row?.age ?? 0));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        })();
        try {
          await p.projection().sweep();
          const firstPass = [...pages];
          const oldest = await within(
            2_000,
            () => draftRow(harness, first),
            (row) => row.watermark === row.revision,
          );
          const contendedWhileHeld = outcomes.contended;
          await p.projection().sweep();
          const secondPass = pages.slice(firstPass.length);
          sampling = false;
          await sampler;
          holding.release();
          await holder;
          const landed = await within(
            40_000,
            async () => {
              let fresh = 0;
              for (const id of rest) {
                const row = await draftRow(harness, id);
                if (row.watermark === row.revision) fresh += 1;
              }
              return fresh;
            },
            (fresh) => fresh === rest.length,
          );
          observe("c", {
            firstPass,
            secondPass,
            oldestMs: oldest.elapsedMs,
            contendedWhileHeld,
            maxLockWaitMs: maxWaitMs,
            landedMs: landed.elapsedMs,
            outcomes,
          });
          assert.deepEqual(firstPass, [50, 1], "one pass, two pages");
          assert.ok(secondPass.length <= 2, "the next tick is a new finite pass");
          assert.ok(contendedWhileHeld > 0, "the held Work's drafts answer contended");
          assert.ok(
            maxWaitMs <= LOCK_TIMEOUT_MS + 100,
            `no lock acquisition waits past the bound: ${maxWaitMs} ms`,
          );
        } finally {
          sampling = false;
          holding.release();
          await holder.catch(() => {});
          p.dispose();
          for (const live of lives) live.destroy();
        }
      },
    });

    /** Every other probe's draft judged fresh, so a sweep sees only this arm's rows. */
    async function markEverythingFresh() {
      await harness.raw`update document_drafts set has_effect_revision = revision
        where kind = 'work_draft' and has_effect_revision < revision`;
    }
  },
};
