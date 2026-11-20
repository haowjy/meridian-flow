/**
 * One live keystroke delivered on two sockets of the same live room (a second tab relaying a
 * peer's update, issue #946), admitted through the production live admission port as
 * Hocuspocus's `beforeSync` does, then applied to the room. A copy the room already holds writes
 * no row. Two copies in flight together can both pass the room's judgement and store a redundant
 * row (accepted: the room judges, the journal does not); the text stays single. A frame whose
 * predecessor the room lacks is refused as a gap and stores nothing.
 */
import assert from "node:assert/strict";
import { readDocumentAuthorityHead } from "../../../../apps/server/server/domains/collab/adapters/drizzle-document-authority-head.ts";
import {
  bindDocumentAuthority,
  documentAuthority,
} from "../../../../apps/server/server/domains/collab/domain/document-handle.ts";
import { createHocuspocusPersistenceService } from "../../../../apps/server/server/domains/collab/hocuspocus-persistence.ts";
import { type Harness, observe, type Probe, Y } from "./harness.mts";

const KEYS = 20;
const DELETES = 5;

export const liveDuplicateFrame: Probe = {
  name: "live-duplicate-frame",
  decision: "#946 the room judges novelty; a concurrent duplicate may store a redundant row",
  expected:
    "sequential copies store one row each; concurrent copies store one or two and the journal text equals the room's; a frame ahead of its predecessor is refused and stores nothing; admission sequences have no gaps",
  async run(harness: Harness) {
    const { raw, ids, persistence } = harness;
    const { documentId, live: seed } = await harness.seedDocument("dup");
    const room = new Y.Doc({ gc: false });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(seed));
    bindDocumentAuthority(room, await readDocumentAuthorityHead(harness.db, documentId));
    const transport = createHocuspocusPersistenceService({
      journal: persistence.journal,
      hocuspocus: () => ({ documents: new Map([[documentId, room]]) }) as never,
      metaForOrigin: () => ({ origin: `human:${ids.user}`, seq: 0 }) as never,
      emitAgentEditInvariantViolation: () => {},
    } as never);
    // The writer's tab: every update it makes is relayed onto a second socket.
    const tab = new Y.Doc({ gc: false });
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(seed));
    const text = (tab.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;

    // One socket's frame: beforeSync admission, then Hocuspocus applies the frame either way.
    const frame = async (update: Uint8Array) => {
      const admission = await transport.admitLiveWriterUpdate({
        documentId,
        document: room,
        expectedGeneration: documentAuthority(room).generation,
        update,
        origin: { type: "user", userId: ids.user as never },
      });
      Y.applyUpdate(room, update, "client");
      return admission.admitted;
    };
    const twice = {
      sequential: async (u: Uint8Array) => [await frame(u), await frame(u)],
      concurrent: (u: Uint8Array) => Promise.all([frame(u), frame(u)]),
    };
    // The tab's own update event: a delete emits a delete-only update (no structs).
    const updateOf = (edit: () => void) => {
      let update: Uint8Array | undefined;
      const capture = (next: Uint8Array) => {
        update = next;
      };
      tab.on("update", capture);
      edit();
      tab.off("update", capture);
      if (!update) throw new Error("the edit made no update");
      return update;
    };

    // Each update sent twice, `count` times over.
    const repeated =
      (count: number, run: (u: Uint8Array) => Promise<boolean[]>, edit: () => void) => async () => {
        const admitted: boolean[] = [];
        for (let i = 0; i < count; i += 1) admitted.push(...(await run(updateOf(edit))));
        return admitted;
      };
    let failed = false;
    const rowsSince = async (start: number) =>
      raw<{ h: string; seq: string }[]>`
        select md5(update_data) h, admission_sequence::text seq from document_yjs_updates
        where document_id=${documentId} and id>${start} and origin_type='human'`;
    const startOf = async () =>
      (
        await raw<
          { start: number }[]
        >`select coalesce(max(id),0)::int start from document_yjs_updates where document_id=${documentId}`
      )[0].start;
    const arms: [string, number, number, () => Promise<boolean[]>][] = [
      [
        "sequential",
        KEYS,
        KEYS,
        repeated(KEYS, twice.sequential, () => text.insert(text.length, "s")),
      ],
      [
        "concurrent",
        KEYS,
        2 * KEYS,
        repeated(KEYS, twice.concurrent, () => text.insert(text.length, "c")),
      ],
      [
        "delete-only concurrent",
        DELETES,
        2 * DELETES,
        repeated(DELETES, twice.concurrent, () => text.delete(0, 1)),
      ],
    ];
    for (const [arm, count, most, run] of arms) {
      const start = await startOf();
      const admitted = await run();
      const rows = await rowsSince(start);
      const sequences = rows.map((row) => BigInt(row.seq)).sort((a, b) => (a < b ? -1 : 1));
      const gaps = sequences.filter((seq, i) => i > 0 && seq !== (sequences[i - 1] ?? 0n) + 1n);
      const result = {
        updates: count,
        framesAdmitted: admitted.filter(Boolean).length,
        journalRows: rows.length,
        sequenceGaps: gaps.length,
      };
      observe(arm, result);
      if (result.journalRows < count || result.journalRows > most || result.sequenceGaps !== 0)
        failed = true;
      if (arm === "sequential" && result.journalRows !== count) failed = true;
    }
    // A frame whose predecessor the room lacks: refused, nothing stored.
    const start = await startOf();
    updateOf(() => text.insert(text.length, " prefix"));
    const tail = updateOf(() => text.insert(text.length, " tail"));
    const refused = await frame(tail).then(
      () => false,
      (cause: unknown) => (cause as Error).message === "writer-frame-gap",
    );
    const gapRows = (await rowsSince(start)).length;
    observe("gap", { refused, journalRows: gapRows });
    if (!refused || gapRows !== 0) failed = true;
    const roomText = room.getXmlFragment("prosemirror").toString();
    const journalText = await harness.liveText(documentId);
    observe("text", { room: roomText, journalMatchesRoom: journalText === roomText });
    assert.equal(journalText, roomText);
    assert.equal(failed, false, "a duplicate or gap frame was stored wrongly");
  },
};
