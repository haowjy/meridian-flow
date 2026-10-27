/**
 * The durable document authority head (`document_yjs_heads`), and its one writer; the one
 * deleter besides is the context purge (`releaseDocumentStorage`), which drops a discarded
 * document's storage with its removal. Only
 * materialization (a create's transaction, or explicit repair of a living document) makes a
 * head; every later write moves it under the caller's document mutation lock and requires a
 * living document in the same statement, so a removal that won the lock refuses here at no
 * extra query on the admitted path. A deleted document keeps its head and history for
 * Restore: readable, frozen.
 */

import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentAuthorityId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documentYjsHeads } from "@meridian/database";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { livingDocumentRefusal, livingDocumentSql } from "../../context/tree/living-document.js";

type AuthorityHeadDb = Pick<Database, "insert" | "update" | "select">;

export type DocumentAuthorityHeadGeneration = {
  authorityId: DocumentAuthorityId;
  generation: bigint;
};

/** A living document's first head, at birth; an existing head (a head-only anomaly) is reused. */
export async function initializeHead(db: AuthorityHeadDb, documentId: DocumentId): Promise<void> {
  await db
    .insert(documentYjsHeads)
    .values({ documentId, schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION) })
    .onConflictDoNothing({ target: documentYjsHeads.documentId });
}

/** The generation a head is born with (the column's default). */
export const FIRST_AUTHORITY_GENERATION = 1n;
/** Rows per statement: bounds the parameter count, not the atomic operation. */
const FRESH_HEAD_BATCH = 500;

/**
 * Heads for documents created in this transaction, each born already naming its first
 * checkpoint, in one statement per batch. The caller wrote the checkpoints under the
 * authority ids passed here, so nothing reads a head before it points at its state.
 */
export async function insertFreshHeads(
  db: AuthorityHeadDb,
  heads: readonly {
    documentId: DocumentId;
    authorityId: DocumentAuthorityId;
    checkpointId: number;
    stateVector: Uint8Array;
  }[],
): Promise<void> {
  for (let offset = 0; offset < heads.length; offset += FRESH_HEAD_BATCH) {
    await db.insert(documentYjsHeads).values(
      heads.slice(offset, offset + FRESH_HEAD_BATCH).map((head) => ({
        documentId: head.documentId,
        authorityId: head.authorityId,
        authorityGeneration: FIRST_AUTHORITY_GENERATION,
        schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
        latestUpdateSeq: 0,
        latestStateVector: Buffer.from(head.stateVector),
        latestCheckpointId: head.checkpointId,
      })),
    );
  }
}

/** The one allocation every live write passes (the journal and settlement's direct writer). */
export async function allocateAdmission(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentAuthorityHeadGeneration & { admissionSequence: bigint }> {
  const [row] = await db
    .update(documentYjsHeads)
    .set({
      nextAdmissionSequence: sql`${documentYjsHeads.nextAdmissionSequence} + 1`,
      updatedAt: sql`now()`,
    })
    .where(living(documentId))
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
 * Moves a living document's head to what was just admitted or checkpointed; a checkpoint
 * insert names its checkpoint. A missing head or a removed document is refused, rolling the
 * caller's rows back with it, so this is the backstop behind each door's own liveness read.
 */
export async function advanceHead(
  db: AuthorityHeadDb,
  documentId: string,
  to: { latestUpdateSeq: number; latestStateVector: Uint8Array; checkpointId?: number },
): Promise<void> {
  const [updated] = await db
    .update(documentYjsHeads)
    .set({
      // Monotonic, so a downgraded server cannot erase the stale-schema fence.
      schemaVersion: sql`greatest(${documentYjsHeads.schemaVersion}, ${packCollabSchemaVersion(COLLAB_SCHEMA_VERSION)})`,
      latestUpdateSeq: to.latestUpdateSeq,
      latestStateVector: Buffer.from(to.latestStateVector),
      ...(to.checkpointId === undefined ? {} : { latestCheckpointId: to.checkpointId }),
      updatedAt: sql`now()`,
    })
    .where(living(documentId))
    .returning({ documentId: documentYjsHeads.documentId });
  if (!updated) throw await refusedAuthority(db, documentId);
}

/** Compaction retired the journal prefix through `seq`; the floor only rises. */
export async function retireThrough(
  db: AuthorityHeadDb,
  documentId: string,
  seq: number,
): Promise<void> {
  await db
    .update(documentYjsHeads)
    .set({ retiredThroughSeq: sql`greatest(${documentYjsHeads.retiredThroughSeq}, ${seq})` })
    .where(living(documentId));
}

/**
 * A document's current head without materializing a missing one. `living` reads it only when
 * the document may change: under the caller's lock, every door that changes retained history
 * (checkpoints, compaction, version replacement) asks for it.
 */
export async function findDocumentAuthorityHead(
  db: AuthorityHeadDb,
  documentId: string,
  options: { living?: boolean } = {},
): Promise<DocumentAuthorityHeadGeneration | null> {
  const [row] = await db
    .select({
      authorityId: documentYjsHeads.authorityId,
      generation: documentYjsHeads.authorityGeneration,
    })
    .from(documentYjsHeads)
    .where(
      options.living
        ? living(documentId)
        : eq(documentYjsHeads.documentId, documentId as DocumentId),
    )
    .limit(1);
  return row ?? null;
}

/** The head a caller requires, else why it has none (with its removal record when `living`). */
export async function readDocumentAuthorityHead(
  db: AuthorityHeadDb,
  documentId: string,
  options: { living?: boolean } = {},
): Promise<DocumentAuthorityHeadGeneration> {
  const row = await findDocumentAuthorityHead(db, documentId, options);
  if (!row) throw await refusedAuthority(db, documentId);
  return row;
}

/** The head's schema version, or null before any head exists. */
export async function findHeadSchemaVersion(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<CollabSchemaVersion | null> {
  const [row] = await db
    .select({ schemaVersion: documentYjsHeads.schemaVersion })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, documentId as DocumentId))
    .limit(1);
  return row ? unpackCollabSchemaVersion(row.schemaVersion) : null;
}

/** Why a document has no head to write or read: its removal, its absence, else no head. */
export async function refusedAuthority(
  db: AuthorityHeadDb,
  documentId: string,
): Promise<DocumentNotFoundError> {
  return (
    (await livingDocumentRefusal(db, documentId as DocumentId)) ??
    new DocumentNotFoundError(documentId, `Document ${documentId} has no authority head`)
  );
}

function living(documentId: string) {
  return and(
    eq(documentYjsHeads.documentId, documentId as DocumentId),
    livingDocumentSql(documentYjsHeads.documentId),
  );
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
export async function replaceGeneration(
  db: Database,
  input: { documentId: DocumentId; checkpointId: number; expectedGeneration: bigint },
): Promise<
  | { ok: true; generation: bigint; checkpointId: number }
  | { ok: false; code: "checkpoint_incomplete" | "stale_generation" }
> {
  const { documentYjsCheckpoints } = await import("@meridian/database");
  const { lockDocumentMutation } = await import("../../../shared/document-mutation-lock.js");

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockDocumentMutation(txDb, input.documentId);
    const head = await readDocumentAuthorityHead(txDb, input.documentId, { living: true });
    if (head.generation !== input.expectedGeneration) {
      return { ok: false as const, code: "stale_generation" as const };
    }
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
