/** Trusted checkpoint minting: a short locked range snapshot, then unlocked journal replay. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentYjsCheckpoints, documentYjsHeads, documentYjsUpdates } from "@meridian/database";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";
import { mintCheckpointCut } from "./checkpoint-capability.js";
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
  const validateInputs = async () => {
    const [head] = await currentDrizzleDb(db as Database)
      .select({
        authorityId: documentYjsHeads.authorityId,
        generation: documentYjsHeads.authorityGeneration,
        retiredThroughSeq: documentYjsHeads.retiredThroughSeq,
      })
      .from(documentYjsHeads)
      .where(eq(documentYjsHeads.documentId, asDocumentId(docId)));
    if (
      !head ||
      head.authorityId !== authority.authorityId ||
      head.generation !== authority.generation ||
      (selected.ceiling > selected.floor && head.retiredThroughSeq > selected.floor)
    ) {
      throw new Error("Checkpoint inputs retired during materialization");
    }
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
    // Check after reading: a concurrent deletion either leaves a complete read
    // or invalidates it. Persistence repeats this check under the mutation lock.
    await validateInputs();
    return materializeCheckpoint(
      base ? new Uint8Array(base.state) : null,
      rows.map((row) => new Uint8Array(row.update)),
    );
  };
  return mintCheckpointCut({
    documentId: docId,
    authority,
    upToSeq: selected.ceiling,
    validateInputs,
    async materializeState() {
      await validateInputs();
      state ??= materialize();
      const bytes = await state;
      await validateInputs();
      return bytes.slice();
    },
  });
}
