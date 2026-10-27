/** Journal-locked cuts and compare-and-set writes of document derived outputs. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentDerivations,
  documentDrafts,
  documentLinks,
  documentMarkdownProjections,
  documents,
  documentYjsHeads,
  projects,
  works,
} from "@meridian/database";
import { and, asc, eq, gt, inArray, isNull, ne, not, notExists, or, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { DocumentLastAddress } from "../../context/document-uri-resolver.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  type DerivationScope,
  DOCUMENT_EXTRACTOR_VERSION,
  type DocumentDerivationCut,
  type DocumentDerivationStore,
} from "../domain/ports/document-derivations.js";
import { loadDocumentState } from "./document-loader.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

/** Caller owns the document mutation lock for this transaction. */
export async function captureDocumentDerivation(
  tx: DrizzleDb,
  documentId: DocumentId,
  lastAddress: DocumentLastAddress,
): Promise<DocumentDerivationCut | null> {
  const [row] = await tx
    .select({
      generation: documentYjsHeads.authorityGeneration,
      admissionSequence: documentYjsHeads.nextAdmissionSequence,
      locationVersion: documents.locationVersion,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .innerJoin(documentYjsHeads, eq(documents.id, documentYjsHeads.documentId))
    .where(eq(documents.id, documentId))
    .limit(1);
  // An already-staged push must still settle after a soft deletion.
  if (!row) return null;
  // Never certify a warm room: writer admission precedes its in-memory apply.
  const state = await loadDocumentState(createDrizzleJournal(tx as Database), documentId);
  if (!state) return null;
  const address = await lastAddress(documentId);
  if (!row.deletedAt && !address)
    throw new Error(`Missing canonical URI for live document ${documentId}`);
  // Under the deleted-ancestor rule a document in a deleted folder or Work holds no address.
  const holderUri = address && !address.deleted ? address.uri : null;
  return {
    documentId,
    holderUri,
    state,
    watermark: {
      generation: row.generation,
      admissionSequence: row.admissionSequence,
      locationVersion: row.locationVersion,
      extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
    },
  };
}

/** Caller owns the document mutation lock for this transaction. */
export async function certifyDocumentDerivation(
  tx: DrizzleDb,
  cut: DocumentDerivationCut,
  outputs: Parameters<DocumentDerivationStore["certify"]>[1],
  at: Date,
): Promise<boolean> {
  const w = cut.watermark;
  const [head] = await tx
    .select()
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, cut.documentId))
    .limit(1);
  if (
    !head ||
    head.authorityGeneration !== w.generation ||
    head.nextAdmissionSequence !== w.admissionSequence
  )
    return false;
  const [location] = await tx
    .select({ version: documents.locationVersion })
    .from(documents)
    .where(eq(documents.id, cut.documentId))
    .for("no key update");
  if (!location || location.version !== w.locationVersion) return false;
  const [existing] = await tx
    .select()
    .from(documentDerivations)
    .where(eq(documentDerivations.documentId, cut.documentId))
    .limit(1);
  if (
    existing &&
    (existing.projectionExtractorVersion > w.extractorVersion ||
      (existing.linksExtractorVersion ?? 0) > w.extractorVersion)
  )
    return false;
  if (
    existing &&
    existing.projectionGeneration === w.generation &&
    existing.projectionAdmissionSequence === w.admissionSequence &&
    existing.projectionLocationVersion === w.locationVersion &&
    existing.projectionExtractorVersion === w.extractorVersion &&
    existing.linksGeneration === w.generation &&
    existing.linksAdmissionSequence === w.admissionSequence &&
    existing.linksLocationVersion === w.locationVersion &&
    existing.linksExtractorVersion === w.extractorVersion
  )
    return true;
  // A re-derivation that changed no text (an extractor bump) is not an edit: `ls` shows
  // `updatedAt` to the model and the writer. Postgres compares, so the old markdown never travels.
  const unchanged = sql`exists (select 1 from ${documentMarkdownProjections} where ${documentMarkdownProjections.documentId} = ${cut.documentId} and ${documentMarkdownProjections.markdown} = ${outputs.markdown})`;
  const [updated] = await tx
    .update(documents)
    .set({
      sizeBytes: Buffer.byteLength(outputs.markdown, "utf8"),
      updatedAt: sql`case when ${unchanged} then ${documents.updatedAt} else ${sql.param(at, documents.updatedAt)} end`,
    })
    .where(and(eq(documents.id, cut.documentId), eq(documents.locationVersion, w.locationVersion)))
    .returning({ id: documents.id });
  if (!updated) return false;
  await tx
    .insert(documentMarkdownProjections)
    .values({
      documentId: cut.documentId,
      markdown: outputs.markdown,
      grepText: outputs.grepText,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: documentMarkdownProjections.documentId,
      set: { markdown: outputs.markdown, grepText: outputs.grepText, updatedAt: at },
    });
  await tx.delete(documentLinks).where(eq(documentLinks.sourceDocumentId, cut.documentId));
  if (outputs.links.length)
    await tx
      .insert(documentLinks)
      .values(outputs.links.map((row) => ({ ...row, sourceDocumentId: cut.documentId })));
  const values = {
    projectionGeneration: w.generation,
    projectionAdmissionSequence: w.admissionSequence,
    projectionLocationVersion: w.locationVersion,
    projectionExtractorVersion: w.extractorVersion,
    linksGeneration: w.generation,
    linksAdmissionSequence: w.admissionSequence,
    linksLocationVersion: w.locationVersion,
    linksExtractorVersion: w.extractorVersion,
  };
  await tx
    .insert(documentDerivations)
    .values({ documentId: cut.documentId, ...values })
    .onConflictDoUpdate({ target: documentDerivations.documentId, set: values });
  return true;
}

/** Registry recovery the derive step drives; the collab domain never imports the registry. */
export type AheadRegistrationRecovery = {
  registerUnregistered(
    scope: { documentId: DocumentId } | DerivationScope | undefined,
    page: { after?: string; limit: number },
  ): Promise<{ registered: number; next: string | null }>;
};

const AHEAD_RECOVERY_PAGE = 100;

/**
 * The derived outputs are behind the document: never derived, or a watermark (projection or
 * links) differs from the document's head, location or the extractor version. Needs
 * `documentDerivations` left-joined to `documents` and `documentYjsHeads`.
 */
const staleDerivation = or(
  isNull(documentDerivations.documentId),
  ne(documentDerivations.projectionGeneration, documentYjsHeads.authorityGeneration),
  ne(documentDerivations.projectionAdmissionSequence, documentYjsHeads.nextAdmissionSequence),
  ne(documentDerivations.projectionLocationVersion, documents.locationVersion),
  ne(documentDerivations.projectionExtractorVersion, DOCUMENT_EXTRACTOR_VERSION),
  isNull(documentDerivations.linksGeneration),
  isNull(documentDerivations.linksAdmissionSequence),
  isNull(documentDerivations.linksLocationVersion),
  isNull(documentDerivations.linksExtractorVersion),
  ne(documentDerivations.linksGeneration, documentYjsHeads.authorityGeneration),
  ne(documentDerivations.linksAdmissionSequence, documentYjsHeads.nextAdmissionSequence),
  ne(documentDerivations.linksLocationVersion, documents.locationVersion),
  ne(documentDerivations.linksExtractorVersion, DOCUMENT_EXTRACTOR_VERSION),
);

export function createDrizzleDocumentDerivationStore(
  db: Database,
  lastAddress: DocumentLastAddress,
  aheads?: { registry: AheadRegistrationRecovery; eventSink?: EventSink },
): DocumentDerivationStore {
  const page = async (
    scope: Parameters<AheadRegistrationRecovery["registerUnregistered"]>[0],
    after: string | undefined,
  ): Promise<{ registered: number; next: string | null }> => {
    if (!aheads) return { registered: 0, next: null };
    try {
      return await aheads.registry.registerUnregistered(scope, {
        after,
        limit: AHEAD_RECOVERY_PAGE,
      });
    } catch (cause) {
      if (aheads.eventSink)
        emitEvent(aheads.eventSink, {
          level: "warn",
          source: "collab.document_derivation",
          name: "ahead_registration.failed",
          payload: unknownToEventPayload(cause),
        });
      return { registered: 0, next: null };
    }
  };
  /** Every page in scope; each page starts after the last key attempted, so it terminates. */
  const drain = async (scope: Parameters<typeof page>[0]) => {
    let registered = 0;
    let after: string | undefined;
    do {
      const progress = await page(scope, after);
      registered += progress.registered;
      after = progress.next ?? undefined;
    } while (after);
    return registered;
  };
  return {
    async registerAheads(documentId) {
      const register = async () => {
        await drain({ documentId });
      };
      // Inside create or push completion the rows are not committed yet; registration takes
      // namespace keys in its own root transaction, so it waits for this commit (§6.1, O6).
      if (!deferUntilDrizzleCommit(register)) await register();
    },
    drainAheads: (scope) => drain(scope),
    recoverAheads: (after) => page(undefined, after),
    capture(documentId) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await lockDocumentMutation(tx, documentId);
        return captureDocumentDerivation(tx, documentId, lastAddress);
      });
    },
    certify(cut, outputs, at) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await lockDocumentMutation(tx, cut.documentId);
        return certifyDocumentDerivation(tx, cut, outputs, at);
      });
    },
    async grepTexts(ids, { ignoreDrafts }) {
      if (!ids.length) return new Map();
      const rows = await currentDrizzleDb(db)
        .select({
          id: documentMarkdownProjections.documentId,
          text: documentMarkdownProjections.grepText,
        })
        .from(documentMarkdownProjections)
        .innerJoin(documents, eq(documents.id, documentMarkdownProjections.documentId))
        .innerJoin(documentYjsHeads, eq(documentYjsHeads.documentId, documents.id))
        .innerJoin(documentDerivations, eq(documentDerivations.documentId, documents.id))
        .where(
          and(
            inArray(documentMarkdownProjections.documentId, ids),
            sql`${documentMarkdownProjections.grepText} is not null`,
            not(staleDerivation as NonNullable<typeof staleDerivation>),
            // A draft reader sees the draft, which the projection of the live document doesn't.
            ignoreDrafts
              ? undefined
              : notExists(
                  currentDrizzleDb(db)
                    .select({ one: sql`1` })
                    .from(documentDrafts)
                    .where(
                      and(
                        eq(documentDrafts.documentId, documents.id),
                        eq(documentDrafts.status, "active"),
                      ),
                    ),
                ),
          ),
        );
      return new Map(
        rows.flatMap((row) => (row.text === null ? [] : [[row.id, row.text] as const])),
      );
    },
    async stale(scope, page) {
      // LIMIT bounds returned stale rows, not the cross-table freshness scan.
      const projectId = sql`coalesce(${contextSources.projectId}, ${works.projectId})`;
      const rows = await currentDrizzleDb(db)
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(documentYjsHeads, eq(documentYjsHeads.documentId, documents.id))
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .leftJoin(works, eq(works.id, contextSources.workId))
        .leftJoin(projects, sql`${projects.id} = ${projectId}`)
        .leftJoin(documentDerivations, eq(documentDerivations.documentId, documents.id))
        .where(
          and(
            isNull(documents.deletedAt),
            staleDerivation,
            scope
              ? scope.personalOwnerId
                ? eq(projects.userId, scope.personalOwnerId)
                : sql`${projectId} = ${scope.projectId}`
              : undefined,
            page?.after ? gt(documents.id, page.after) : undefined,
          ),
        )
        .orderBy(asc(documents.id))
        .limit(page?.limit ?? 100);
      return rows.map((row) => row.id as DocumentId);
    },
  };
}
