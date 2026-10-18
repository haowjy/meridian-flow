/**
 * Phase 4 (design §2.2, F1/R2/R3/G4): an append's receipt, novelty and authorship are judged
 * under the branch row lock against the committed prefix, never against the replica the frame
 * read off the lock. Two admissions over one branch through the production coordinator and
 * store, ordered by a hook or a held `appendRows`, each arm on its own draft:
 *
 * (a) a dependent update before its prefix is not sequenced and closes `4207`; the merged
 *     resend lands as one row; (b) a dependent update queued behind its prefix's lock lands
 *     with its own clock; (c) an exact resend overlapping the commit is contained; (d) a merged
 *     partial resend is trimmed to its novel struct; (e) a re-sent delete is not this row's
 *     effect; (f) a delete of a reserved fact committed before the lock is refused; (g) a
 *     restoration claim is certified on the row's before-view; (h) one logical write across two
 *     rows nets to one receipt; (i) delete ranges at and past the frontier.
 *
 * Negative controls on `586e58ae1e`: (a) admits U2 alone with an empty receipt and no close;
 * (d) journals the whole merged update; (e) records the re-sent delete as the row's effect;
 * (i)'s unknown delete is journaled with its prefix absent.
 */
import assert from "node:assert/strict";
import {
  appendProvenanceFacts,
  PROVENANCE_TARGETS_TYPE,
} from "../../../../apps/server/server/domains/collab/domain/provenance.ts";
import { captureUndoRestorationClaims } from "../../../../packages/prosemirror-schema/src/restoration-claims.ts";
import {
  appendToFirstParagraph,
  type Harness,
  independently,
  observe,
  type Probe,
  Y,
} from "./harness.mts";
import {
  captureUpdate,
  durableDoc,
  firstText,
  journalRows,
  nth,
  openRoom,
  PREFIX_MISSING_CLOSE,
  pauseAt,
  pausedAppend,
  phase4Coordinator,
  receipts,
  runArms,
  seedDraft,
  structsOf,
  tabOn,
} from "./phase4.mts";
import { openGateway } from "./room-enrollment.mts";

const WRITER = 900_001;

/** The clocks of `client` an update's structs cover. */
function clocksOf(update: Uint8Array, client: number): number[] {
  return Y.decodeUpdate(update).structs.flatMap((struct) =>
    struct.id.client === client
      ? Array.from({ length: struct.length }, (_, n) => struct.id.clock + n)
      : [],
  );
}

/**
 * The second key's wait: phase 4 queues it on the branch row (the sequence point); a wait on
 * the Work row is today's membership-flip lock on a keystroke, which phase 4 deletes.
 */
const KEY_WAIT = /document_drafts|"works"/;
function assertWaitedOnDraftRow(waiting: readonly string[]) {
  assert.ok(
    waiting.every((query) => /document_drafts/.test(query)),
    `the second key waits on the branch row, not a Work: ${JSON.stringify(waiting)}`,
  );
}

const expanded = (ranges: readonly { client: number; clock: number; len: number }[]) =>
  ranges.flatMap((r) => Array.from({ length: r.len }, (_, n) => `${r.client}:${r.clock + n}`));

/** Two keystrokes from one writer tab on `draft`'s base: U1 types A, U2 types B after it. */
function twoKeys(draft: { live: Y.Doc }) {
  const tab = tabOn(draft.live, WRITER);
  const u1 = appendToFirstParagraph(tab, "A");
  const u2 = appendToFirstParagraph(tab, "B");
  tab.destroy();
  return { u1, u2 };
}

async function durable(harness: Harness, draftId: string) {
  const state = await harness.readDraft(draftId);
  return {
    revision: state.revision,
    text: state.text,
    rows: (await journalRows(harness, draftId)).length,
    receipts: (await receipts(harness, draftId)).length,
  };
}

export const appendNovelty: Probe = {
  name: "append-novelty",
  decision: "D28 (§2.2 F1/R2/R3/G4)",
  expected:
    "(a) U2 alone closes 4207 with zero rows, then U1+U2 lands as one row; (b)–(i) one complete receipt per kept row, trimmed to its novel part, judged on the committed prefix",
  async run(harness) {
    const coordinator = phase4Coordinator(harness);
    await runArms({
      async "a-dependent-before-prefix"() {
        const close = PREFIX_MISSING_CLOSE;
        const draft = await seedDraft(harness, "novelty-a");
        const { u1, u2 } = twoKeys(draft);
        const gateway = openGateway(harness, harness.store);
        try {
          const room = await gateway.load(draft.draftId, draft.generation);
          const before = await durable(harness, draft.draftId);
          const second = await gateway.send(room, draft.draftId, draft.generation, u2);
          const afterSecond = await durable(harness, draft.draftId);
          const merged = await gateway.send(
            room,
            draft.draftId,
            draft.generation,
            Y.mergeUpdates([u1, u2]),
          );
          const after = await durable(harness, draft.draftId);
          const rows = await journalRows(harness, draft.draftId);
          const edits = await receipts(harness, draft.draftId);
          observe("a", {
            before,
            second,
            afterSecond,
            merged,
            after,
            rowStructs: rows.map((r) => structsOf(r.update)),
          });
          assert.deepEqual(second, { ok: false, closes: [close] });
          assert.deepEqual(afterSecond, before, "U2 alone writes nothing and keeps the revision");
          assert.deepEqual(merged, { ok: true, closes: [] });
          assert.equal(rows.length, 1);
          assert.deepEqual(clocksOf(nth(rows, 0).update, WRITER), [0, 1]);
          assert.equal(edits.length, 1);
          assert.deepEqual(expanded(nth(edits, 0).flatMap((p) => p.inserted)), [
            `${WRITER}:0`,
            `${WRITER}:1`,
          ]);
          assert.match(after.text, /BaseAB/);
          assert.deepEqual(close, { code: 4207, reason: "draft-prefix-missing" });
        } finally {
          draft.live.destroy();
          await gateway.close();
        }
      },

      async "b-dependent-queued-behind-prefix"() {
        const draft = await seedDraft(harness, "novelty-b");
        const { u1, u2 } = twoKeys(draft);
        const tab = await openRoom(harness, coordinator, draft);
        const pause = pauseAt("branch.append.beforeCommit");
        try {
          const first = independently(() => tab.send(u1));
          await pause.entered;
          const second = independently(() => tab.send(u2));
          const waiting = await harness.waitForLockWaiter(KEY_WAIT);
          pause.release();
          const outcomes = [await first, await second];
          const rows = await journalRows(harness, draft.draftId);
          const edits = await receipts(harness, draft.draftId);
          const after = await durable(harness, draft.draftId);
          observe("b", { waiting, outcomes, after, receipts: edits });
          assert.deepEqual(outcomes, ["appended", "appended"]);
          assert.equal(rows.length, 2);
          assert.equal(edits.length, 2);
          const second2 = edits.find((parts) => nth(parts, 0).rowId === nth(rows, 1).id);
          assert.deepEqual(expanded(second2?.[0]?.inserted ?? []), [`${WRITER}:1`]);
          assert.match(after.text, /BaseAB/);
          assertWaitedOnDraftRow(waiting);
        } finally {
          pause.remove();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "c-exact-resend-overlapping-commit"() {
        const draft = await seedDraft(harness, "novelty-c");
        const { u1 } = twoKeys(draft);
        const tab = await openRoom(harness, coordinator, draft);
        const before = await durable(harness, draft.draftId);
        const pause = pauseAt("branch.append.beforeCommit");
        try {
          const first = independently(() => tab.send(u1));
          await pause.entered;
          const resend = independently(() => tab.send(u1));
          const waiting = await harness.waitForLockWaiter(KEY_WAIT);
          pause.release();
          const outcomes = [await first, await resend];
          const after = await durable(harness, draft.draftId);
          observe("c", { waiting, outcomes, before, after });
          assert.deepEqual(outcomes, ["appended", "contained"]);
          assert.equal(after.rows, 1);
          assert.equal(after.receipts, 1);
          assert.equal(after.revision, before.revision + 1);
          assertWaitedOnDraftRow(waiting);
        } finally {
          pause.remove();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "d-merged-partial-resend"() {
        const draft = await seedDraft(harness, "novelty-d");
        const { u1, u2 } = twoKeys(draft);
        const tab = await openRoom(harness, coordinator, draft);
        try {
          const outcomes = [await tab.send(u1), await tab.send(Y.mergeUpdates([u1, u2]))];
          const rows = await journalRows(harness, draft.draftId);
          const edits = await receipts(harness, draft.draftId);
          observe("d", {
            outcomes,
            rowStructs: rows.map((r) => structsOf(r.update)),
            receipts: edits,
          });
          assert.deepEqual(outcomes, ["appended", "appended"]);
          assert.equal(rows.length, 2);
          assert.deepEqual(
            clocksOf(nth(rows, 1).update, WRITER),
            [1],
            "the resend is trimmed to U2",
          );
          const last = edits.find((parts) => nth(parts, 0).rowId === nth(rows, 1).id);
          assert.deepEqual(expanded(last?.flatMap((p) => p.inserted) ?? []), [`${WRITER}:1`]);
        } finally {
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "e-resent-delete-with-insert"() {
        const draft = await seedDraft(harness, "novelty-e");
        const writer = tabOn(draft.live, WRITER);
        const tab = await openRoom(harness, coordinator, draft);
        try {
          const del = captureUpdate(writer, () => firstText(writer).delete(0, 1));
          const ins = appendToFirstParagraph(writer, "Z");
          const outcomes = [await tab.send(del), await tab.send(Y.mergeUpdates([del, ins]))];
          const rows = await journalRows(harness, draft.draftId);
          const edits = await receipts(harness, draft.draftId);
          const last = edits.find((parts) => nth(parts, 0).rowId === nth(rows, -1).id);
          observe("e", { outcomes, receipt: last });
          assert.deepEqual(outcomes, ["appended", "appended"]);
          assert.deepEqual(
            last?.flatMap((p) => p.deleted),
            [],
            "the re-sent delete is held",
          );
          assert.deepEqual(expanded(last?.flatMap((p) => p.inserted) ?? []), [`${WRITER}:0`]);
        } finally {
          writer.destroy();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "f-reserved-target-committed-between"() {
        const draft = await seedDraft(harness, "novelty-f");
        // Another connection's agent row carries a provenance fact the frame's base lacks.
        const browser = tabOn(draft.live, 17);
        const prose = Y.decodeUpdate(Y.encodeStateAsUpdate(draft.live)).structs.find(
          (s) => s instanceof Y.Item && s.content instanceof Y.ContentString,
        );
        if (!prose) throw new Error("no prose struct");
        const range = { clientID: prose.id.client, clock: prose.id.clock, length: prose.length };
        const fact = appendProvenanceFacts(browser, {
          targets: [{ version: 1, target: range, root: range }],
        });
        browser.clientID = 900_777;
        const deletion = captureUpdate(browser, () =>
          browser.getMap(PROVENANCE_TARGETS_TYPE).delete(`${range.clientID}:${range.clock}`),
        );
        const pause = pausedAppend(harness.store);
        const frames = phase4Coordinator(harness, { store: pause.paused });
        const tab = await openRoom(harness, frames, draft);
        try {
          const frame = independently(() => tab.send(deletion));
          await pause.entered;
          const source = tabOn(draft.live, 900_778);
          Y.applyUpdate(source, fact);
          const committed = await independently(() =>
            harness.coordinator.commitSegmentRows({
              draftId: draft.draftId,
              expectedGeneration: draft.generation,
              sourceDoc: source,
              rows: [{ draftId: draft.draftId, source: "agent", updateData: fact }],
            }),
          );
          source.destroy();
          pause.release();
          const outcome = await frame;
          const rows = await journalRows(harness, draft.draftId);
          const doc = await durableDoc(harness, draft.draftId);
          const facts = doc.getMap(PROVENANCE_TARGETS_TYPE).size;
          doc.destroy();
          observe("f", { committed, outcome, rows: rows.map((r) => r.source), facts });
          assert.equal(committed, true);
          assert.ok(typeof outcome === "object" && "refused" in outcome, "the frame is refused");
          assert.deepEqual(
            rows.map((r) => r.source),
            ["agent"],
            "no writer row",
          );
          assert.equal(facts, 1, "the fact survives");
        } finally {
          browser.destroy();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "g-restoration-under-concurrent-row"() {
        const draft = await seedDraft(harness, "novelty-g", "The serpent waits.");
        const browser = tabOn(draft.live, WRITER);
        const detach = captureUndoRestorationClaims(browser);
        const text = firstText(browser);
        const undo = new Y.UndoManager(text);
        const pause = pausedAppend(harness.store);
        const frames = phase4Coordinator(harness, { store: pause.paused });
        const tab = await openRoom(harness, frames, draft);
        try {
          const deleted = captureUpdate(browser, () => text.delete(4, 7));
          // The first appendRows is held: let the delete land on the unpaused path.
          const quiet = await openRoom(harness, coordinator, draft);
          assert.equal(await quiet.send(deleted), "appended");
          quiet.room.destroy();
          const restored = captureUpdate(browser, () => undo.undo());
          const frame = independently(() => tab.send(restored));
          await pause.entered;
          const other = tabOn(draft.live, 900_779);
          Y.applyUpdate(other, deleted);
          const concurrent = await independently(async () => {
            const room = await openRoom(harness, coordinator, draft);
            try {
              return await room.send(appendToFirstParagraph(other, " Other"));
            } finally {
              room.room.destroy();
            }
          });
          other.destroy();
          pause.release();
          const outcome = await frame;
          const rows = await journalRows(harness, draft.draftId);
          const aliases = rows.at(-1)?.meta.restorationAliases ?? [];
          observe("g", {
            concurrent,
            outcome,
            aliases: aliases.length,
            text: (await harness.readDraft(draft.draftId)).text,
          });
          assert.equal(concurrent, "appended");
          assert.equal(outcome, "appended");
          assert.equal(aliases.length, 1, "one certified alias");
        } finally {
          detach();
          undo.destroy();
          browser.destroy();
          tab.room.destroy();
          draft.live.destroy();
        }
      },

      async "h-one-logical-write-two-rows"() {
        const draft = await seedDraft(harness, "novelty-h");
        const source = tabOn(draft.live, 900_333);
        try {
          const insert = appendToFirstParagraph(source, "X");
          const remove = captureUpdate(source, () => {
            const t = firstText(source);
            t.delete(t.length - 1, 1);
          });
          const committed = await harness.coordinator.commitSegmentRows({
            draftId: draft.draftId,
            expectedGeneration: draft.generation,
            sourceDoc: source,
            rows: [
              {
                draftId: draft.draftId,
                source: "agent",
                updateData: insert,
                documentEditKey: "h",
              },
              {
                draftId: draft.draftId,
                source: "agent",
                updateData: remove,
                documentEditKey: "h",
              },
            ],
          });
          const edits = await receipts(harness, draft.draftId);
          observe("h", { committed, edits });
          assert.equal(committed, true);
          assert.equal(edits.length, 1, "one document_edits row");
          assert.equal(nth(edits, 0).length, 2, "two parts");
          for (const part of nth(edits, 0))
            assert.deepEqual([part.inserted, part.deleted], [[], []]);
        } finally {
          source.destroy();
          draft.live.destroy();
        }
      },

      async "i-held-deletes-at-the-frontier"() {
        // A fresh client inserting X and deleting it in one merged update.
        {
          const draft = await seedDraft(harness, "novelty-i1");
          const writer = tabOn(draft.live, 900_303);
          const tab = await openRoom(harness, coordinator, draft);
          try {
            const ins = appendToFirstParagraph(writer, "X");
            const del = captureUpdate(writer, () => {
              const t = firstText(writer);
              t.delete(t.length - 1, 1);
            });
            const outcome = await tab.send(Y.mergeUpdates([ins, del]));
            const edits = await receipts(harness, draft.draftId);
            observe("i transient", { outcome, edits });
            assert.equal(outcome, "appended");
            assert.equal(edits.length, 1);
            for (const part of nth(edits, 0))
              assert.deepEqual([part.inserted, part.deleted], [[], []]);
          } finally {
            writer.destroy();
            tab.room.destroy();
            draft.live.destroy();
          }
        }
        // A delete range straddling the client's frontier: clock 0 committed and deleted, 1 new.
        {
          const draft = await seedDraft(harness, "novelty-i2");
          const writer = tabOn(draft.live, 900_304);
          const tab = await openRoom(harness, coordinator, draft);
          try {
            const t = firstText(writer);
            assert.equal(await tab.send(appendToFirstParagraph(writer, "X")), "appended");
            assert.equal(
              await tab.send(captureUpdate(writer, () => t.delete(t.length - 1, 1))),
              "appended",
            );
            appendToFirstParagraph(writer, "Y");
            t.delete(t.length - 1, 1);
            const outcome = await tab.send(Y.encodeStateAsUpdate(writer));
            const rows = await journalRows(harness, draft.draftId);
            const edits = await receipts(harness, draft.draftId);
            const last = edits.find((parts) => nth(parts, 0).rowId === nth(rows, -1).id);
            observe("i straddling", { outcome, rows: rows.length, receipt: last });
            assert.equal(outcome, "appended");
            assert.equal(rows.length, 3);
            const deleted = expanded(last?.flatMap((p) => p.deleted) ?? []);
            assert.ok(
              !deleted.includes("900304:0"),
              "the held delete of clock 0 is not this row's",
            );
            assert.deepEqual(clocksOf(nth(rows, -1).update, 900_304), [1], "only the novel struct");
          } finally {
            writer.destroy();
            tab.room.destroy();
            draft.live.destroy();
          }
        }
        // A delete-only update naming a clock the server never saw: not sequenced, 4207.
        {
          const draft = await seedDraft(harness, "novelty-i3");
          const writer = tabOn(draft.live, 900_305);
          const gateway = openGateway(harness, harness.store);
          try {
            appendToFirstParagraph(writer, "W");
            const del = captureUpdate(writer, () => {
              const t = firstText(writer);
              t.delete(t.length - 1, 1);
            });
            const room = await gateway.load(draft.draftId, draft.generation);
            const before = await durable(harness, draft.draftId);
            const sent = await gateway.send(room, draft.draftId, draft.generation, del);
            const after = await durable(harness, draft.draftId);
            observe("i unknown delete", { sent, before, after });
            assert.deepEqual(sent, { ok: false, closes: [PREFIX_MISSING_CLOSE] });
            assert.deepEqual(after, before);
          } finally {
            writer.destroy();
            await gateway.close();
            draft.live.destroy();
          }
        }
      },
    });
  },
};
