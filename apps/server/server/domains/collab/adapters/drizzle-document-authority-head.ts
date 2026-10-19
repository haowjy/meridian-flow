/** The durable document authority head: admission allocation, require-existing reads, replacement. */

import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentAuthorityId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentYjsHeads } from "@meridian/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { DocumentRemovedError } from "../../context/ports/document-removals.js";
import { createDrizzleDocumentRemovals } from "../../context/tree/document-removals.js";
import { documentNotDeletedSql } from "../../context/tree/tree-view-sql.js";

type AuthorityHeadDb = Pick<Database, "insert" | "update" | "select">;

export type DocumentAuthorityHeadGeneration = {
  authorityId: DocumentAuthorityId;
  generation: bigint;
};

/**
 * The one allocation every live write passes (the journal and settlement's direct writer),
 * under the caller's document mutation lock: it requires an existing head on a living
 * document in the same statement, so a removal that won the lock refuses here at no extra
 * query on the admitted path.
 */
export async function allocateDocumentAdmission(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentAuthorityHeadGeneration & { admissionSequence: bigint }> {
  const [row] = await db
    .update(documentYjsHeads)
    .set({
      nextAdmissionSequence: sql`${documentYjsHeads.nextAdmissionSequence} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(documentYjsHeads.documentId, documentId as DocumentId),
        documentNotDeletedSql(documentYjsHeads.documentId),
      ),
    )
    .returning({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
      nextAdmissionSequence: documentYjsHeads.nextAdmissionSequence,
    });
  if (!row) throw await refusedAuthority(db, documentId);
  return {
    authorityId: row.authorityId,
    generation: row.generation,
    admissionSequence: row.nextAdmissionSequence - 1n,
  };
}

/**
 * The authority head of a document that must already have one. Only materialization (the
 * create's transaction, or explicit repair) makes a head; every other reader fails here.
 */
export async function readDocumentAuthorityHead(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentAuthorityHeadGeneration> {
  const row = await findDocumentAuthorityHead(db, documentId);
  if (!row) throw await refusedAuthority(db, documentId);
  return row;
}

/** Returns the current authority head without materializing a missing row. */
export async function findDocumentAuthorityHead(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentAuthorityHeadGeneration | null> {
  const [row] = await db
    .select({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
    })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, documentId as DocumentId))
    .limit(1);
  return row ?? null;
}

/** Why a document has no authority to write or read: its removal, else no head at all. */
export async function refusedAuthority(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentRemovedError | DocumentNotFoundError> {
  const removal = (
    await createDrizzleDocumentRemovals(db as Database).lookup([documentId as DocumentId])
  ).get(documentId as DocumentId);
  return removal
    ? new DocumentRemovedError(documentId as DocumentId, removal)
    : new DocumentNotFoundError(documentId, `Document ${documentId} has no authority head`);
}

/**
 * Reads through the caller's transaction, like the journal snapshot it validates.
 * A room loaded inside a transaction that already admitted to this head would
 * otherwise wait on its own row lock from a second connection.
 */
export function createDrizzleAuthorityGenerationReader(db: Database) {
  return async (documentId: DocumentId): Promise<bigint> =>
    (await readDocumentAuthorityHead(currentDrizzleDb(db), documentId)).generation;
}

/**
 * Atomically installs a retained checkpoint as a new fenced durable authority generation.
 * The source checkpoint is copied rather than applied to the current Y.Doc: Yjs apply
 * would merge the checkpoint and current live-document state instead of replacing it.
 */
export async function replaceDocumentAuthorityHeadGeneration(
  db: Database,
  input: { documentId: DocumentId; checkpointId: number; expectedGeneration: bigint },
): Promise<
  | { ok: true; generation: bigint; checkpointId: number }
  | { ok: false; code: "authority_head_busy" | "checkpoint_incomplete" | "stale_generation" }
> {
  const { branchPushSettlementBatches, branchPushSettlementOutbox, documentYjsCheckpoints } =
    await import("@meridian/database");
  const { lockDocumentMutation } = await import("../../../shared/document-mutation-lock.js");

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockDocumentMutation(txDb, input.documentId);
    const [head] = await txDb
      .select({
        authorityId: documentYjsHeads.authorityId,
        generation: documentYjsHeads.authorityGeneration,
      })
      .from(documentYjsHeads)
      .where(eq(documentYjsHeads.documentId, input.documentId))
      .limit(1);
    if (!head || head.generation !== input.expectedGeneration) {
      return { ok: false as const, code: "stale_generation" as const };
    }
    const [pending] = await txDb
      .select({ pushId: branchPushSettlementOutbox.pushId })
      .from(branchPushSettlementOutbox)
      .innerJoin(
        branchPushSettlementBatches,
        eq(branchPushSettlementBatches.id, branchPushSettlementOutbox.batchId),
      )
      .where(
        and(
          eq(branchPushSettlementOutbox.documentId, input.documentId),
          inArray(branchPushSettlementBatches.state, ["pending", "blocked"]),
        ),
      )
      .limit(1);
    if (pending) return { ok: false as const, code: "authority_head_busy" as const };

    const [checkpoint] = await txDb
      .select()
      .from(documentYjsCheckpoints)
      .where(
        and(
          eq(documentYjsCheckpoints.id, input.checkpointId),
          eq(documentYjsCheckpoints.documentId, input.documentId),
        ),
      )
      .limit(1);
    if (!checkpoint?.attributionManifest || checkpoint.state.length === 0) {
      return { ok: false as const, code: "checkpoint_incomplete" as const };
    }

    const generation = head.generation + 1n;
    const [installed] = await txDb
      .insert(documentYjsCheckpoints)
      .values({
        documentId: input.documentId,
        authorityId: head.authorityId,
        authorityGeneration: generation,
        // The checkpoint carries old-generation birth attribution, but the new
        // generation has no admitted journal prefix yet. Keeping the old floor
        // would make its first admission look like a replay gap.
        attributionManifest: rebaseCheckpointManifest(checkpoint.attributionManifest),
        state: checkpoint.state,
        stateVector: checkpoint.stateVector,
        upToSeq: checkpoint.upToSeq,
        reason: `authority-replacement:${checkpoint.id}`,
      })
      .returning({ id: documentYjsCheckpoints.id });
    if (!installed) throw new Error("Failed to install the durable authority checkpoint");
    const [updated] = await txDb
      .update(documentYjsHeads)
      .set({
        authorityGeneration: generation,
        nextAdmissionSequence: 1n,
        retiredThroughSeq: 0,
        latestUpdateSeq: checkpoint.upToSeq,
        latestStateVector: checkpoint.stateVector,
        latestCheckpointId: installed.id,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(documentYjsHeads.documentId, input.documentId),
          eq(documentYjsHeads.authorityGeneration, input.expectedGeneration),
        ),
      )
      .returning({ generation: documentYjsHeads.authorityGeneration });
    if (!updated) return { ok: false as const, code: "stale_generation" as const };
    return { ok: true as const, generation, checkpointId: installed.id };
  });
}

function rebaseCheckpointManifest(manifest: unknown): unknown {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    manifest.version !== 1 ||
    !("attributions" in manifest) ||
    !Array.isArray(manifest.attributions)
  ) {
    return manifest;
  }
  return { ...manifest, floor: null };
}
