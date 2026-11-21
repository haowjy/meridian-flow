/** Trusted checkpoint minting: a short locked range snapshot, then unlocked journal replay. */

import { dropUnseenContent } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  observationFrontiers,
} from "@meridian/database";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import { liveRoom } from "../domain/observation-rooms.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";
import { mintCheckpointCut } from "./checkpoint-capability.js";
import {
  type MaterializedCheckpoint,
  materializeCheckpoint,
} from "./checkpoint-materialization.js";

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
    ${docId}::text, ${authority.authorityId}::uuid
  )`);
  if (!reference) return null;
  const selected = {
    baseId: reference.base_id === null ? null : Number(reference.base_id),
    floor: Number(reference.floor_seq),
    ceiling: Number(reference.ceiling_seq),
  };
  const validateInputs = async () => {
    const [head] = await currentDrizzleDb(db as Database)
      .select({ authorityId: documentYjsHeads.authorityId })
      .from(documentYjsHeads)
      .where(eq(documentYjsHeads.documentId, asDocumentId(docId)));
    if (head?.authorityId !== authority.authorityId)
      throw new Error("Checkpoint inputs retired during materialization");
  };
  // The room's latest model read: the chat working on the document now plans on it. Every
  // chat's last read would keep each discarded rewrite a fresh chat wrote, for good.
  const frontiers = async () =>
    (
      await currentDrizzleDb(db as Database)
        .select({ snapshot: observationFrontiers.snapshot })
        .from(observationFrontiers)
        .where(eq(observationFrontiers.roomKey, liveRoom(docId)))
        .orderBy(desc(observationFrontiers.recordedSeq))
        .limit(1)
    ).map((row) => new Uint8Array(row.snapshot));
  let state: Promise<MaterializedCheckpoint> | undefined;
  const materialize = async () => {
    const readDb = currentDrizzleDb(db as Database) as JournalDb;
    // A store since the capture may have deleted the base (a superseded background checkpoint);
    // the journal keeps every row, so an older surviving checkpoint and more rows give the same
    // state.
    const [base] = selected.baseId
      ? await readDb
          .select({ state: documentYjsCheckpoints.state, upToSeq: documentYjsCheckpoints.upToSeq })
          .from(documentYjsCheckpoints)
          .where(
            and(
              eq(documentYjsCheckpoints.documentId, asDocumentId(docId)),
              eq(documentYjsCheckpoints.authorityId, authority.authorityId),
              lte(documentYjsCheckpoints.upToSeq, selected.floor),
            ),
          )
          .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
          .limit(1)
      : [];
    const replayFloor = base?.upToSeq ?? 0;
    const rows = await readDb
      .select({ update: documentYjsUpdates.updateData })
      .from(documentYjsUpdates)
      .where(
        and(
          eq(documentYjsUpdates.documentId, asDocumentId(docId)),
          eq(documentYjsUpdates.authorityId, authority.authorityId),
          gt(documentYjsUpdates.id, replayFloor),
          lte(documentYjsUpdates.id, selected.ceiling),
        ),
      )
      .orderBy(asc(documentYjsUpdates.id));
    // Check after reading: a removal since the capture invalidates the read.
    // Persistence repeats this check under the mutation lock.
    await validateInputs();
    return materializeCheckpoint(
      base ? new Uint8Array(base.state) : null,
      rows.map((row) => new Uint8Array(row.update)),
      frontiers,
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
      const bytes = (await state).state;
      await validateInputs();
      return bytes.slice();
    },
    async history() {
      state ??= materialize();
      const { state: bytes, structs, contentBytes } = await state;
      return { bytes: bytes.byteLength, structs, contentBytes };
    },
    async dropUnseenContent(document) {
      dropUnseenContent(document, await frontiers());
    },
  });
}
