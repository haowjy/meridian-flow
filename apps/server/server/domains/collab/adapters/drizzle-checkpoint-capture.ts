/** Trusted checkpoint minting: a short locked range snapshot, then unlocked journal replay. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentYjsCheckpoints, documentYjsUpdates } from "@meridian/database";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";
import { materializeCheckpoint } from "./checkpoint-materialization.js";
import { findDocumentAuthorityHead } from "./drizzle-document-authority-head.js";

type JournalDb = Pick<Database, "select" | "transaction" | "execute">;
const asDocumentId = (id: string) => id as DocumentId;

export async function captureDrizzleCheckpoint(
  db: JournalDb,
  docId: string,
  captured: CheckpointAuthority,
): Promise<CapturedCheckpointCut | null> {
  // Roll back the read-only savepoint deliberately: PostgreSQL releases locks
  // acquired since it, even when this adapter joins an ambient transaction.
  // Returning normally from a nested transaction would retain those locks.
  const readDb = currentDrizzleDb(db as Database) as JournalDb;
  const holder: {
    snapshot: {
      authority: CheckpointAuthority;
      baseId: number | null;
      floor: number;
      ceiling: number;
    } | null;
  } = { snapshot: null };
  const release = new Error("Release checkpoint snapshot lock");
  try {
    await readDb.transaction(async (tx) => {
      await lockDocumentMutation(tx, docId);
      const current = await findDocumentAuthorityHead(tx, docId);
      if (
        !current ||
        current.authorityId !== captured.authorityId ||
        current.generation !== captured.generation
      )
        return;
      const [base] = await tx
        .select({ id: documentYjsCheckpoints.id, upToSeq: documentYjsCheckpoints.upToSeq })
        .from(documentYjsCheckpoints)
        .where(
          and(
            eq(documentYjsCheckpoints.documentId, asDocumentId(docId)),
            eq(documentYjsCheckpoints.authorityId, current.authorityId),
            eq(documentYjsCheckpoints.authorityGeneration, current.generation),
          ),
        )
        .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
        .limit(1);
      const [last] = await tx
        .select({ seq: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(
          and(
            eq(documentYjsUpdates.documentId, asDocumentId(docId)),
            eq(documentYjsUpdates.authorityId, current.authorityId),
            eq(documentYjsUpdates.authorityGeneration, current.generation),
          ),
        )
        // Admission order is allocated under this same document lock. Use
        // its generation-qualified index, not a scan through retired rows.
        .orderBy(desc(documentYjsUpdates.admissionSequence), desc(documentYjsUpdates.batchOrdinal))
        .limit(1);
      holder.snapshot = {
        authority: current,
        baseId: base?.id ?? null,
        floor: base?.upToSeq ?? 0,
        ceiling: Math.max(base?.upToSeq ?? 0, last?.seq ?? 0),
      };
      throw release;
    });
  } catch (cause) {
    if (cause !== release) throw cause;
  }
  const selected = holder.snapshot;
  if (!selected) return null;
  const authority = Object.freeze({ ...selected.authority });
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
