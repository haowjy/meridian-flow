/** Allocates ordered journal admissions from the durable document authority head. */

import type { DocumentAuthorityId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentYjsHeads } from "@meridian/database";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { DocumentAuthorityHeads } from "../domain/ports/document-authority-heads.js";

type AuthorityHeadDb = Pick<Database, "insert" | "update" | "select">;

export type DocumentAuthorityHeadGeneration = {
  authorityId: DocumentAuthorityId;
  generation: bigint;
};

export async function allocateDocumentAdmission(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentAuthorityHeadGeneration & { admissionSequence: bigint }> {
  await ensureDocumentAuthorityHead(db, documentId);
  const [row] = await db
    .update(documentYjsHeads)
    .set({
      nextAdmissionSequence: sql`${documentYjsHeads.nextAdmissionSequence} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(documentYjsHeads.documentId, documentId as DocumentId))
    .returning({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
      nextAdmissionSequence: documentYjsHeads.nextAdmissionSequence,
    });
  if (!row) throw new Error("Failed to allocate an admission from the durable authority head");
  return {
    authorityId: row.authorityId,
    generation: row.generation,
    admissionSequence: row.nextAdmissionSequence - 1n,
  };
}

export async function readDocumentAuthorityHead(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentAuthorityHeadGeneration> {
  await ensureDocumentAuthorityHead(db, documentId);
  const [row] = await db
    .select({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
    })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, documentId as DocumentId))
    .limit(1);
  if (!row) throw new Error("Failed to read the durable document authority head");
  return row;
}

async function ensureDocumentAuthorityHead(db: AuthorityHeadDb, documentId: string): Promise<void> {
  await db
    .insert(documentYjsHeads)
    .values({ documentId: documentId as DocumentId, schemaVersion: COLLAB_SCHEMA_VERSION })
    .onConflictDoNothing({ target: documentYjsHeads.documentId });
}

export function createDrizzleDocumentAuthorityHeads(db: Database): DocumentAuthorityHeads {
  return {
    async ensureAndReadAuthorityHeads(documentIds) {
      const uniqueIds = [...new Set(documentIds)].sort() as DocumentId[];
      if (uniqueIds.length === 0) return [];

      const existing = await readAuthorityHeads(db, uniqueIds);
      if (existing.length === uniqueIds.length) return existing;

      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await tx
          .insert(documentYjsHeads)
          .values(
            uniqueIds.map((documentId) => ({
              documentId,
              schemaVersion: COLLAB_SCHEMA_VERSION,
            })),
          )
          .onConflictDoNothing({ target: documentYjsHeads.documentId });

        const rows = await readAuthorityHeads(tx, uniqueIds);
        if (rows.length !== uniqueIds.length) {
          throw new Error("Failed to read initialized durable document authority heads");
        }
        return rows;
      });
    },
  };
}

export function createDrizzleAuthorityGenerationReader(db: AuthorityHeadDb) {
  return async (documentId: DocumentId): Promise<bigint> =>
    (await readDocumentAuthorityHead(db, documentId)).generation;
}

async function readAuthorityHeads(db: AuthorityHeadDb, documentIds: DocumentId[]) {
  const rows = await db
    .select({
      documentId: documentYjsHeads.documentId,
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
      nextAdmissionSequence: documentYjsHeads.nextAdmissionSequence,
    })
    .from(documentYjsHeads)
    .where(inArray(documentYjsHeads.documentId, documentIds))
    .orderBy(asc(documentYjsHeads.documentId));
  return rows.map((row) => ({
    documentId: row.documentId,
    authorityId: row.authorityId,
    generation: row.generation,
    admittedThrough: row.nextAdmissionSequence - 1n,
  }));
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
  const { and, ne } = await import("drizzle-orm");
  const { branchPushSettlementOutbox, documentYjsCheckpoints } = await import("@meridian/database");
  const { lockDocumentMutation } = await import("./drizzle-document-mutation-lock.js");

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
      .where(
        and(
          eq(branchPushSettlementOutbox.documentId, input.documentId),
          ne(branchPushSettlementOutbox.state, "completed"),
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
