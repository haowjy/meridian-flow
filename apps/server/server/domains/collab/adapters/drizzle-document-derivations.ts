/** Journal-locked cuts and compare-and-set publication of document derived outputs. */
import { isProjectScopedScheme, parseContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentDerivations,
  documentLinks,
  documents,
  documentYjsHeads,
  projects,
  works,
} from "@meridian/database";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import {
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
  resolveUri: (tx: DrizzleDb, documentId: DocumentId) => Promise<string | null>,
): Promise<DocumentDerivationCut | null> {
  const personal = alias(projects, "owner_personal_project");
  const projectId = sql`coalesce(${contextSources.projectId}, ${works.projectId})`;
  const [row] = await tx
    .select({
      generation: documentYjsHeads.authorityGeneration,
      admissionSequence: documentYjsHeads.nextAdmissionSequence,
      locationVersion: documents.locationVersion,
      holderProjectId: projects.id,
      personalProjectId: personal.id,
      kind: documents.kind,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .innerJoin(documentYjsHeads, eq(documents.id, documentYjsHeads.documentId))
    .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .innerJoin(projects, sql`${projects.id} = ${projectId}`)
    .leftJoin(
      personal,
      and(
        eq(personal.userId, projects.userId),
        eq(personal.isPersonal, true),
        isNull(personal.deletedAt),
      ),
    )
    .where(eq(documents.id, documentId))
    .limit(1);
  // An already-staged push must still settle after a soft deletion.
  if (!row) return null;
  // Never certify a warm room: writer admission precedes its in-memory apply.
  const state = await loadDocumentState(createDrizzleJournal(tx as Database), documentId);
  if (!state) return null;
  const holderUri = row.kind === "manifest" ? null : await resolveUri(tx, documentId);
  if (row.kind === "content" && !row.deletedAt && !holderUri)
    throw new Error(`Missing canonical URI for live document ${documentId}`);
  if (holderUri) {
    const parsed = parseContextUri(holderUri);
    if (
      !parsed.ok ||
      (!isProjectScopedScheme(parsed.value.scheme) && parsed.value.authority.kind === "contextual")
    )
      throw new Error(`Holder URI requires explicit authority: ${holderUri}`);
  }
  return {
    documentId,
    holderUri,
    holderProjectId: row.holderProjectId,
    personalProjectId: row.personalProjectId,
    kind: row.kind,
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
  const [updated] = await tx
    .update(documents)
    .set({
      markdownProjection: outputs.markdown,
      sizeBytes: Buffer.byteLength(outputs.markdown, "utf8"),
      updatedAt: at,
    })
    .where(and(eq(documents.id, cut.documentId), eq(documents.locationVersion, w.locationVersion)))
    .returning({ id: documents.id });
  if (!updated) return false;
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

export function createDrizzleDocumentDerivationStore(
  db: Database,
  resolveUri: (tx: DrizzleDb, documentId: DocumentId) => Promise<string | null>,
): DocumentDerivationStore {
  return {
    capture(documentId) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await lockDocumentMutation(tx, documentId);
        return captureDocumentDerivation(tx, documentId, resolveUri);
      });
    },
    certify(cut, outputs, at) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await lockDocumentMutation(tx, cut.documentId);
        return certifyDocumentDerivation(tx, cut, outputs, at);
      });
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
            or(
              isNull(documentDerivations.documentId),
              ne(documentDerivations.projectionGeneration, documentYjsHeads.authorityGeneration),
              ne(
                documentDerivations.projectionAdmissionSequence,
                documentYjsHeads.nextAdmissionSequence,
              ),
              ne(documentDerivations.projectionLocationVersion, documents.locationVersion),
              ne(documentDerivations.projectionExtractorVersion, DOCUMENT_EXTRACTOR_VERSION),
              isNull(documentDerivations.linksGeneration),
              isNull(documentDerivations.linksAdmissionSequence),
              isNull(documentDerivations.linksLocationVersion),
              isNull(documentDerivations.linksExtractorVersion),
              ne(documentDerivations.linksGeneration, documentYjsHeads.authorityGeneration),
              ne(
                documentDerivations.linksAdmissionSequence,
                documentYjsHeads.nextAdmissionSequence,
              ),
              ne(documentDerivations.linksLocationVersion, documents.locationVersion),
              ne(documentDerivations.linksExtractorVersion, DOCUMENT_EXTRACTOR_VERSION),
            ),
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
