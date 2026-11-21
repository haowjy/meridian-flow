/**
 * The durable document authority head (`document_yjs_heads`), and its one writer; the one
 * deleter besides is the context purge (`releaseDocumentStorage`), which drops a discarded
 * document's storage with its removal. A document's delete takes its head by trigger. Only
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
import { and, eq, or, sql } from "drizzle-orm";
import { livingDocumentRefusal, textHeldSql } from "../../context/tree/living-document.js";

type AuthorityHeadDb = Pick<Database, "insert" | "update" | "select">;

export type DocumentAuthorityHead = { authorityId: DocumentAuthorityId };

/**
 * A living document's first head, at birth; an existing head of a document (a head-only anomaly)
 * is reused. A head of another kind under this id is a list's, and no document is made of it.
 */
export async function initializeHead(db: AuthorityHeadDb, documentId: DocumentId): Promise<void> {
  const inserted = await db
    .insert(documentYjsHeads)
    .values({ documentId, schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION) })
    .onConflictDoNothing({ target: documentYjsHeads.documentId })
    .returning({ documentId: documentYjsHeads.documentId });
  if (inserted.length > 0) return;
  const [existing] = await db
    .select({ kind: documentYjsHeads.kind })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, documentId));
  if (existing && existing.kind !== "document")
    throw new Error(`Document ${documentId} has the id of a ${existing.kind}'s journal`);
}

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
): Promise<DocumentAuthorityHead & { admissionSequence: bigint }> {
  const [row] = await db
    .update(documentYjsHeads)
    .set({
      nextAdmissionSequence: sql`${documentYjsHeads.nextAdmissionSequence} + 1`,
      updatedAt: sql`now()`,
    })
    .where(holdsText(documentId))
    .returning({
      authorityId: documentYjsHeads.authorityId,
      nextAdmissionSequence: documentYjsHeads.nextAdmissionSequence,
    });
  if (!row) throw await refusedAuthority(db, documentId);
  return {
    authorityId: row.authorityId,
    admissionSequence: row.nextAdmissionSequence - 1n,
  };
}

/**
 * Moves a document's head, in Trash or not, to what was just admitted or checkpointed; a checkpoint
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
    .where(holdsText(documentId))
    .returning({ documentId: documentYjsHeads.documentId });
  if (!updated) throw await refusedAuthority(db, documentId);
}

/**
 * A document's current head without materializing a missing one. `notPurged` reads it only when
 * the document may change: under the caller's lock, every door that changes retained history
 * (checkpoints) asks for it.
 */
export async function findDocumentAuthorityHead(
  db: AuthorityHeadDb,
  documentId: string,
  options: { notPurged?: boolean } = {},
): Promise<DocumentAuthorityHead | null> {
  const [row] = await db
    .select({
      authorityId: documentYjsHeads.authorityId,
    })
    .from(documentYjsHeads)
    .where(
      options.notPurged
        ? holdsText(documentId)
        : eq(documentYjsHeads.documentId, documentId as DocumentId),
    )
    .limit(1);
  return row ?? null;
}

/** The head a caller requires, else why it has none (with its removal record when `notPurged`). */
export async function readDocumentAuthorityHead(
  db: AuthorityHeadDb,
  documentId: string,
  options: { notPurged?: boolean } = {},
): Promise<DocumentAuthorityHead> {
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

function holdsText(documentId: string) {
  return and(
    eq(documentYjsHeads.documentId, documentId as DocumentId),
    or(eq(documentYjsHeads.kind, "tree_list"), textHeldSql(documentYjsHeads.documentId)),
  );
}
