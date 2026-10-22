/** Fold legacy Work drafts and preserve all generations' positive Apply evidence before retiring placement. */
import {
  appendApplyRecord,
  convertLegacyDraft,
  DRAFT_SERVER_CLIENT_ID,
  type ItemRange,
  readApplyRecord,
} from "@meridian/agent-edit/diff";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import type postgres from "postgres";
import * as Y from "yjs";

type Range = { client: number; clock: number; len: number };
type Effect = { inserted: Range[]; deleted: Range[] };
type Draft = {
  id: string;
  document_id: string;
  state: Buffer;
  live_cut: Buffer | null;
  status: string;
  generation: number;
  checkpoint_seq: string;
};

export async function migrate(sql: postgres.ReservedSql): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    await sql`BEGIN`;
    try {
      await sql`SET LOCAL lock_timeout = '2s'`;
      // Do not skip held rows: another converter must commit before this scan can pass it.
      const rows: Draft[] =
        cursor === null
          ? await sql<
              Draft[]
            >`SELECT id, document_id, state, live_cut, status, generation, checkpoint_seq
            FROM document_drafts WHERE kind = 'work_draft' ORDER BY id LIMIT 1 FOR UPDATE`
          : await sql<
              Draft[]
            >`SELECT id, document_id, state, live_cut, status, generation, checkpoint_seq
            FROM document_drafts WHERE kind = 'work_draft' AND id > ${cursor}
            ORDER BY id LIMIT 1 FOR UPDATE`;
      const row = rows[0];
      if (!row) {
        await sql`COMMIT`;
        return;
      }
      cursor = row.id;
      // Empty bytes mean the closed content was released; never resurrect it.
      if (row.state.length) {
        const doc = createCollabYDoc({ gc: false });
        try {
          Y.applyUpdate(doc, row.state);
          const tail = await sql<{ id: string; update_data: Buffer }[]>`
            SELECT id, update_data FROM draft_write_journal
            WHERE draft_id = ${row.id} AND generation = ${row.generation}
              AND id > ${row.checkpoint_seq} ORDER BY id`;
          for (const journal of tail) Y.applyUpdate(doc, journal.update_data);
          const convertBase = row.status === "active" && row.live_cut !== null;
          let hasEffect: boolean | null = null;
          if (convertBase) {
            const converted = convertLegacyDraft({
              state: Y.encodeStateAsUpdate(doc),
              liveCut: row.live_cut,
            });
            if (converted.kind !== "converted") throw new Error(`Unresolved draft ${row.id}`);
            Y.applyUpdate(doc, converted.state);
            hasEffect = converted.hasEffect;
          }
          doc.clientID = DRAFT_SERVER_CLIENT_ID;
          // Origin never changes on Apply. Placement did, including receipts of reset generations
          // whose structs no longer exist in the room. Preserve ranges, not item lookups.
          const parts = await sql<{ effect: Effect }[]>`SELECT p.effect FROM document_edit_parts p
            JOIN document_edits e ON e.id = p.edit_id
            WHERE e.document_id = ${row.document_id} AND origin->>'kind' = 'pending' AND origin->>'draftId' = ${row.id}
              AND placement->>'kind' = 'live' ORDER BY p.id`;
          const tuple = (r: Range): ItemRange => [r.client, r.clock, r.len];
          const record = readApplyRecord(doc);
          const entries = new Set(
            record.map((entry) => JSON.stringify({ base: entry.base, settled: entry.settled })),
          );
          let appended = false;
          doc.transact(() => {
            for (const { effect } of parts) {
              const entry = {
                base: effect.inserted.map(tuple),
                settled: effect.deleted.map(tuple),
              };
              const key = JSON.stringify(entry);
              if (entries.has(key)) continue;
              appendApplyRecord(doc, entry);
              entries.add(key);
              appended = true;
            }
          }, "migrate-historical-apply");
          if (convertBase || appended) {
            const [head] = await sql<{ seq: string }[]>`SELECT coalesce(max(id), 0) AS seq
              FROM draft_write_journal WHERE draft_id = ${row.id}`;
            if (!head) throw new Error("Missing draft journal head");
            // The lock rechecks the cut, and the UPDATE independently fences client-1 authorship.
            await sql`UPDATE document_drafts SET state = ${Buffer.from(Y.encodeStateAsUpdate(doc))},
              state_vector = ${Buffer.from(Y.encodeStateVector(doc))},
              checkpoint_seq = ${head.seq}, revision = revision + 1,
              checkpoint_revision = revision + 1,
              has_effect = coalesce(${hasEffect}::boolean, has_effect),
              has_effect_revision = CASE WHEN ${convertBase} THEN revision + 1 ELSE has_effect_revision END,
              live_cut = CASE WHEN ${convertBase} THEN NULL ELSE live_cut END
              WHERE id = ${row.id} AND (NOT ${convertBase} OR live_cut IS NOT NULL)`;
          }
        } finally {
          doc.destroy();
        }
      }
      await sql`COMMIT`;
    } catch (error) {
      await sql`ROLLBACK`;
      throw error;
    }
  }
}
