/** Trusted checkpoint minting: a short locked range snapshot, then unlocked journal replay. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentYjsCheckpoints, documentYjsUpdates } from "@meridian/database";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";
import { materializeCheckpoint } from "./checkpoint-materialization.js";

type JournalDb = Pick<Database, "select" | "execute">;
const asDocumentId = (id: string) => id as DocumentId;

export async function captureDrizzleCheckpoint(
  db: JournalDb,
  docId: string,
  captured: CheckpointAuthority,
): Promise<CapturedCheckpointCut | null> {
  const authority = Object.freeze({ ...captured });
  const [reference] = await currentDrizzleDb(db as Database).execute<{
    base_id: string | number | null;
    floor_seq: string | number;
    ceiling_seq: string | number;
  }>(sql`select * from capture_document_checkpoint_range(
    ${docId}::text, ${authority.authorityId}::uuid, ${authority.generation}::bigint
  )`);
  if (!reference) return null;
  const selected = {
    baseId: reference.base_id === null ? null : Number(reference.base_id),
    floor: Number(reference.floor_seq),
    ceiling: Number(reference.ceiling_seq),
  };
  let state: Promise<Uint8Array> | undefined;
  const materialize = async () => {
    const readDb = currentDrizzleDb(db as Database) as JournalDb;
    const base = selected.baseId
      ? (
          await readDb
            .select()
            .from(documentYjsCheckpoints)
            .where(eq(documentYjsCheckpoints.id, selected.baseId))
        )[0]
      : null;
    if (selected.baseId && !base) throw new Error("Checkpoint base retired during capture");
    const rows = await readDb
      .select({ update: documentYjsUpdates.updateData })
      .from(documentYjsUpdates)
      .where(
        and(
          eq(documentYjsUpdates.documentId, asDocumentId(docId)),
          eq(documentYjsUpdates.authorityId, authority.authorityId),
          eq(documentYjsUpdates.authorityGeneration, authority.generation),
          gt(documentYjsUpdates.id, selected.floor),
          lte(documentYjsUpdates.id, selected.ceiling),
        ),
      )
      .orderBy(asc(documentYjsUpdates.id));
    // Compaction/restore replace the checkpoint atomically with deleting
    // suffix rows. Never certify a floor if those inputs may be missing.
    const [compacted] = await readDb
      .select({ id: documentYjsCheckpoints.id })
      .from(documentYjsCheckpoints)
      .where(
        and(
          eq(documentYjsCheckpoints.documentId, asDocumentId(docId)),
          eq(documentYjsCheckpoints.authorityId, authority.authorityId),
          eq(documentYjsCheckpoints.authorityGeneration, authority.generation),
          eq(documentYjsCheckpoints.reason, "compact"),
          gt(documentYjsCheckpoints.upToSeq, selected.floor),
        ),
      )
      .limit(1);
    if (compacted) {
      throw new Error("Checkpoint inputs retired during materialization");
    }
    return materializeCheckpoint(
      base ? new Uint8Array(base.state) : null,
      rows.map((row) => new Uint8Array(row.update)),
    );
  };
  return Object.freeze({
    documentId: docId,
    authority,
    upToSeq: selected.ceiling,
    async materializeState() {
      state ??= materialize();
      return (await state).slice();
    },
  }) as CapturedCheckpointCut;
}
