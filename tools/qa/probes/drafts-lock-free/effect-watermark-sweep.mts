/**
 * Phase 4 (design §3.2 sweep, §3.3 legacy baselines, R5/R6/G5/G6, review C1): the watermark
 * `has_effect_revision` says which judgements are stale, and a finite keyset sweep repairs them.
 *
 * (a) a key committed with no projection job leaves the watermark behind and the badge stale;
 *     a fresh process's `sweep()` repairs both.
 * (b) a compaction leaves the watermark behind; the sweep re-judges the same value.
 * (c) fairness: 51 stale branches, the newest 50 on a Work an open transaction holds, the oldest
 *     on an idle Work. One pass tracks all 51 in two pages; the oldest is written within 2 s
 *     while the 50 answer `contended`; no projection connection waits on one lock longer than
 *     the 100 ms `lock_timeout` (per lock acquisition, C1); the next tick is a new pass;
 *     releasing the Work lets the 50 land on their backoff.
 * (d) legacy rows (null `live_cut`, `has_effect` true, watermark -1): one sweep establishes each
 *     resolvable baseline through `pullWorkDraft` and ends fresh; the one on a document with a
 *     terminally blocked settlement is diagnosed once, stays at -1, takes no further live
 *     snapshot across three ticks, and lands fresh once the batch completes and a key arrives.
 *
 * (c) and (d) first mark every other probe's draft fresh, so the sweep sees only their rows.
 * Negative control on `586e58ae1e`: there is no watermark column, no job and no store door.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { observe, type Probe, Y } from "./harness.mts";
import {
  draftRow,
  durableDoc,
  type EffectWrite,
  judgedEffect,
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
    "(a) the sweep repairs an unprojected key; (b) a compaction's stale watermark is re-judged; (c) one fair pass of two pages, the idle Work's draft written within 2 s, no lock wait past 100 ms; (d) legacy baselines established, the blocked one parked after one capture",
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
          if (!read) throw new Error("branch missing");
          const checkpoint = await durableDoc(harness, draft.draftId);
          const compacted = await harness.store.commitRewrite({
            draftId: draft.draftId,
            doc: checkpoint,
            policy: {
              kind: "fold",
              checkpointRevision: read.documentDraft.checkpointRevision,
              seq: 0,
            },
            fence: { kind: "none" },
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
          assert.ok(contendedWhileHeld > 0, "the held Work's branches answer contended");
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

      async "d-legacy-baselines"() {
        await markEverythingFresh();
        const legacy = async (label: string, typed: boolean) => {
          const draft = await seedDraft(harness, label);
          if (typed) {
            const tab = await openRoom(harness, phase4Coordinator(harness), draft);
            for (const token of [" one", " two"]) await tab.send(keystroke(tab.room, token));
            const read = await harness.store.readDraftAt(draft.draftId);
            if (!read) throw new Error("branch missing");
            const checkpoint = await durableDoc(harness, draft.draftId);
            await harness.store.commitRewrite({
              draftId: draft.draftId,
              doc: checkpoint,
              policy: {
                kind: "fold",
                checkpointRevision: read.documentDraft.checkpointRevision,
                seq: 0,
              },
              fence: { kind: "none" },
              operation: { kind: "compact" },
            });
            checkpoint.destroy();
            tab.room.destroy();
          }
          // What the pre-phase-4 creator left: no baseline, the schema default effect, -1.
          await harness.raw`update document_drafts set live_cut = null, has_effect = true,
            has_effect_revision = -1 where id = ${draft.draftId}`;
          return draft;
        };
        const empty = await legacy("legacy-empty", false);
        const typed = await legacy("legacy-typed", true);
        const blocked = await legacy("legacy-blocked", false);
        const batchId = await blockSettlement(blocked);
        const before = Object.fromEntries(
          await Promise.all(
            [empty, typed, blocked].map(
              async (d) => [d.draftId, await draftRow(harness, d.draftId)] as const,
            ),
          ),
        );
        const p = await openProjected(harness);
        try {
          await p.projection().sweep();
          const resolved = await within(
            5_000,
            async () => {
              const rows = await Promise.all(
                [empty, typed].map((d) => draftRow(harness, d.draftId)),
              );
              return rows.map((row) => row.watermark === row.revision);
            },
            (fresh) => fresh.every(Boolean),
          );
          for (const draft of [empty, typed]) {
            const row = await draftRow(harness, draft.draftId);
            const baseline = await baselineText(draft.draftId);
            observe(`d ${draft.draftId.slice(0, 15)}`, {
              row,
              baseline,
              live: await harness.liveText(draft.documentId),
            });
            assert.ok(row.liveCutStored, "the pull wrote the baseline");
            assert.equal(
              baseline,
              await harness.liveText(draft.documentId),
              "equal to live's state",
            );
            assert.ok(row.revision > (before[draft.draftId]?.revision ?? 0), "revision bumped");
            assert.equal(row.hasEffect, await judgedEffect(harness, draft.draftId));
          }
          const capturesAfterFirst = p.captures.get(blocked.documentId) ?? 0;
          for (let tick = 0; tick < 3; tick += 1) await p.projection().sweep();
          const capturesAfterTicks = p.captures.get(blocked.documentId) ?? 0;
          const parked = await draftRow(harness, blocked.draftId);
          const diagnosed = p.blocked.filter((entry) => entry.draftId === blocked.draftId).length;
          await harness.raw`update branch_push_settlement_batches set state = 'completed',
            completed_at = now(), blocked_at = null where id = ${batchId}`;
          const tab = await openRoom(harness, p.coordinator, blocked);
          const key = await tab.send(keystroke(tab.room, " wake"));
          tab.room.destroy();
          const woke = await within(
            3_000,
            () => draftRow(harness, blocked.draftId),
            (row) => row.watermark === row.revision,
          );
          observe("d blocked", {
            capturesAfterFirst,
            capturesAfterTicks,
            parked,
            diagnosed,
            key,
            woke: woke.observation,
            resolvedMs: resolved.elapsedMs,
          });
          assert.equal(diagnosed, 1, "diagnosed once");
          assert.equal(parked.watermark, -1, "stays stale");
          assert.equal(
            capturesAfterTicks,
            capturesAfterFirst,
            "no further live snapshot across three ticks",
          );
          assert.equal(key, "appended");
        } finally {
          p.dispose();
          for (const draft of [empty, typed, blocked]) draft.live.destroy();
        }
      },
    });

    /** Every other probe's draft judged fresh, so a sweep sees only this arm's rows. */
    async function markEverythingFresh() {
      await harness.raw`update document_drafts set has_effect_revision = revision
        where kind = 'work_draft' and has_effect_revision < revision`;
    }

    /** The baseline's text, or null when none is stored. */
    async function baselineText(draftId: string): Promise<string | null> {
      const [row] = await harness.raw<{ live_cut: Uint8Array | null }[]>`
        select live_cut from document_drafts where id = ${draftId}`;
      if (!row?.live_cut) return null;
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, new Uint8Array(row.live_cut));
      const text = doc.getXmlFragment("prosemirror").toString();
      doc.destroy();
      return text;
    }

    /** A terminally blocked settlement on the draft's document (D22), as the r3/r4 fixture. */
    async function blockSettlement(draft: {
      draftId: string;
      generation: number;
      documentId: string;
      live: Y.Doc;
    }) {
      const batchId = randomUUID();
      await harness.raw`insert into branch_push_settlement_batches (id, state, blocked_at, last_error_code)
        values (${batchId}, 'blocked', now(), 'corrupt_settlement_authority')`;
      const [push] = await harness.raw<{ id: string }[]>`
        insert into push_lineage (draft_id, draft_generation, document_id, journal_ids, idempotency_key)
        values (${draft.draftId}, ${draft.generation}, ${draft.documentId}, '{}', ${randomUUID()}) returning id`;
      const bytes = Buffer.from(Y.encodeStateAsUpdate(draft.live));
      await harness.raw`insert into branch_push_settlement_outbox
        (push_id, batch_id, document_id, document_title, lock_cut_update, push_update, trail_seed)
        values (${push?.id ?? ""}, ${batchId}, ${draft.documentId}, 'blocked', ${bytes}, ${bytes}, '{}')`;
      return batchId;
    }
  },
};
