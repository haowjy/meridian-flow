/**
 * Save-time re-check for a reply's documents (D29): a Work archived during the
 * reply refuses that Work's own files, its scratch and (in draft mode) its
 * draft. Project-owned files written live save normally.
 */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, documents, works } from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { AgentEditDestination, RefusedResponseDocument } from "../domain/agent-edit-cores.js";

export function createDrizzleResponseDocumentScreen(db: Database) {
  return async (input: {
    documents: ReadonlyArray<{ documentId: DocumentId; destination: AgentEditDestination }>;
  }): Promise<RefusedResponseDocument[]> => {
    if (input.documents.length === 0) return [];
    const sources = await currentDrizzleDb(db)
      .select({ documentId: documents.id, workId: contextSources.workId })
      .from(documents)
      .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
      .where(
        inArray(
          documents.id,
          input.documents.map((document) => document.documentId),
        ),
      );
    const sourceWork = new Map(sources.map((row) => [row.documentId, row.workId]));
    const owners = input.documents.flatMap(({ documentId, destination }) => {
      const workId =
        destination.kind === "draft" ? destination.workId : (sourceWork.get(documentId) ?? null);
      return workId ? [{ documentId, workId: workId as WorkId }] : [];
    });
    if (owners.length === 0) return [];
    const archived = new Map(
      (
        await currentDrizzleDb(db)
          .select({ id: works.id, slug: works.slug, archivedAt: works.archivedAt })
          .from(works)
          .where(inArray(works.id, [...new Set(owners.map((owner) => owner.workId))]))
      )
        .filter((work) => work.archivedAt !== null)
        .map((work) => [work.id, work.slug] as const),
    );
    return owners.flatMap(({ documentId, workId }) =>
      archived.has(workId)
        ? [{ documentId, reason: "work_archived" as const, workSlug: archived.get(workId) ?? null }]
        : [],
    );
  };
}
