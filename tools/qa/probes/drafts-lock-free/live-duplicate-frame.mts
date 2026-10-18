/**
 * One live keystroke delivered on two sockets of the same live room (a second tab relaying a
 * peer's update, issue #946), admitted through the production live admission port as
 * Hocuspocus's `beforeSync` does, then applied to the room. Three arms: the second copy after
 * the first is applied, both copies concurrent (the second arrives inside the first's admission
 * transaction), and a delete-only update sent twice concurrently. Whatever the interleaving, a
 * copy whose structs and deletes the stored document already holds writes no journal row, no
 * human edit and no admission sequence.
 */
import assert from "node:assert/strict";
import { ensureAndReadDocumentAuthorityHead } from "../../../../apps/server/server/domains/collab/adapters/drizzle-document-authority-head.ts";
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
  decision: "#946 one novelty owner under the document lock",
  expected:
    "every arm: one admitted frame, one journal row and one human edit per update; admission sequences have no gaps; journal text equals the room's",
  async run(harness: Harness) {
    const { raw, ids, persistence } = harness;
    const { documentId, live: seed } = await harness.seedDocument("dup");
    const room = new Y.Doc({ gc: false });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(seed));
    bindDocumentAuthority(room, await ensureAndReadDocumentAuthorityHead(harness.db, documentId));
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

    const arms: [string, number, (u: Uint8Array) => Promise<boolean[]>, () => void][] = [
      ["sequential", KEYS, twice.sequential, () => text.insert(text.length, "s")],
      ["concurrent", KEYS, twice.concurrent, () => text.insert(text.length, "c")],
      ["delete-only concurrent", DELETES, twice.concurrent, () => text.delete(0, 1)],
    ];
    let failed = false;
    for (const [arm, count, run, edit] of arms) {
      const [{ start }] = await raw<
        { start: number }[]
      >`select coalesce(max(id),0)::int start from document_yjs_updates where document_id=${documentId}`;
      const admitted: boolean[] = [];
      for (let i = 0; i < count; i += 1) admitted.push(...(await run(updateOf(edit))));
      const rows = await raw<{ h: string; seq: string }[]>`
        select md5(update_data) h, admission_sequence::text seq from document_yjs_updates
        where document_id=${documentId} and id>${start} and origin_type='human'`;
      const [{ edits }] = await raw<{ edits: number }[]>`
        select count(*)::int edits from document_edits e where e.document_id=${documentId}
          and e.actor='human' and exists
          (select 1 from document_yjs_updates u where u.edit_id=e.id and u.id>${start})`;
      const sequences = rows.map((row) => BigInt(row.seq)).sort((a, b) => (a < b ? -1 : 1));
      const gaps = sequences.filter((seq, i) => i > 0 && seq !== (sequences[i - 1] ?? 0n) + 1n);
      const result = {
        updates: count,
        framesAdmitted: admitted.filter(Boolean).length,
        journalRows: rows.length,
        distinctPayloads: new Set(rows.map((row) => row.h)).size,
        humanEdits: edits,
        sequenceGaps: gaps.length,
      };
      observe(arm, result);
      if (
        result.framesAdmitted !== count ||
        result.journalRows !== count ||
        result.humanEdits !== count ||
        result.sequenceGaps !== 0
      )
        failed = true;
    }
    const roomText = room.getXmlFragment("prosemirror").toString();
    const journalText = await harness.liveText(documentId);
    observe("text", { room: roomText, journalMatchesRoom: journalText === roomText });
    assert.equal(journalText, roomText);
    assert.equal(failed, false, "a duplicate copy was journaled");
  },
};
