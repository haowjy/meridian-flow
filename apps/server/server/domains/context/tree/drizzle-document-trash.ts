/** Drizzle adapter for restorable document trash and retention: emptying Trash, and the purge window. */
import { type DocumentId, type ProjectId, serializeRemovalIdentity } from "@meridian/contracts";
import type { DocumentTrashEntry, GetDocumentTrashResponse } from "@meridian/contracts/protocol";
import { deletionPurgeAt, deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import {
  branches,
  branchTreeNodes,
  contextSources,
  documents,
  projects,
  threads,
  treeNodes,
  works,
} from "@meridian/database/schema";
import { descendantsOf, LIVE, listRecords, settlementsOf } from "@meridian/project-tree";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import { createObjectRelease, type ObjectStorePort } from "../../storage/index.js";
import type { DocumentPurgeDraftDisposal, DocumentTrash } from "../ports/document-trash.js";
import { type TreeList, type TreeListStore, TreeRefusal } from "../ports/tree-list-store.js";
import { releaseDocumentContent } from "./release-document-content.js";
import { retentionHolds } from "./retention-holds.js";
import { loadDocumentAddresses } from "./tree-addresses.js";

/** Documents released in one run: bounds how long one run holds the database. */
const DOCUMENT_PURGE_BATCH_LIMIT = 100;
const ENTRY_PAGE = 100;
const sourceProjects = alias(projects, "document_trash_source_projects");
const requestProjects = alias(projects, "document_trash_request_projects");

/** A project owns its own sources plus its account's personal user:// source. */
function projectTrashMember() {
  return sql<boolean>`(${eq(sourceProjects.id, requestProjects.id)}
    OR (${eq(contextSources.slug, "user")}
      AND ${eq(sourceProjects.userId, requestProjects.userId)}))`;
}

/** An unsettled drafted record on one of the nodes, or one that creates or moves under them. */
function unsettledOn(doc: Y.Doc, nodes: ReadonlySet<string>): boolean {
  const settled = settlementsOf(doc);
  return listRecords(doc).some(
    (record) =>
      record.draft !== null &&
      !settled.has(record.id) &&
      (nodes.has(record.node) ||
        ((record.type === "create" || record.type === "move") && nodes.has(record.parent))),
  );
}

type Released = { documentIds: DocumentId[]; storageUrls: string[] };

export function createDrizzleDocumentTrash(deps: {
  db: Database;
  objectStore: Pick<ObjectStorePort, "delete">;
  eventSink: EventSink;
  drafts: DocumentPurgeDraftDisposal;
  tree: Pick<TreeListStore, "submit">;
  /** The document's stored Yjs as markdown; the trash keeps no text of its own. */
  readMarkdown(documentId: DocumentId): Promise<string>;
}): DocumentTrash {
  const objects = createObjectRelease({
    objectStore: deps.objectStore,
    onFailure(key, error) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "context.document-purge",
        name: "object_delete.failed",
        payload: { key, error },
      });
    },
  });

  /** The Trash rows of a project: documents with a delete in force, in a living source. */
  const rows = async (projectId: ProjectId, documentIds?: readonly DocumentId[]) =>
    currentDrizzleDb(deps.db)
      .select({
        documentId: treeNodes.id,
        name: treeNodes.name,
        trashedAt: sql<Date>`${treeNodes.trashedAt}`.mapWith(treeNodes.trashedAt),
        locationVersion: treeNodes.locationVersion,
      })
      .from(treeNodes)
      .innerJoin(documents, eq(documents.id, treeNodes.id))
      .innerJoin(contextSources, eq(contextSources.id, treeNodes.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .innerJoin(
        sourceProjects,
        eq(sourceProjects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
      )
      .innerJoin(requestProjects, eq(requestProjects.id, projectId))
      .where(
        and(
          eq(treeNodes.kind, "document"),
          isNotNull(treeNodes.trashRecord),
          isNull(documents.contentPurgedAt),
          isNull(contextSources.deletedAt),
          isNull(sourceProjects.deletedAt),
          isNull(requestProjects.deletedAt),
          projectTrashMember(),
          documentIds ? inArray(treeNodes.id, [...documentIds]) : undefined,
        ),
      )
      .orderBy(desc(treeNodes.trashedAt), desc(treeNodes.id));

  const entries = async (
    result: Awaited<ReturnType<typeof rows>>,
  ): Promise<DocumentTrashEntry[]> => {
    const tx = currentDrizzleDb(deps.db);
    const ids = result.map(({ documentId }) => documentId as DocumentId);
    const addresses = await loadDocumentAddresses(deps.db, { ids });
    const held = new Map<DocumentId, Array<{ id: string; name: string }>>();
    if (ids.length) {
      const pending = await tx.execute<{ document_id: string; id: string; name: string }>(sql`
        SELECT DISTINCT p.document_id::text,
               coalesce(w.id, t.id)::text AS id, coalesce(w.name, nullif(t.title, ''), 'A chat') AS name
        FROM (${retentionHolds(ids)}) p
        JOIN ${branches} b ON b.id = p.branch_id
        LEFT JOIN ${works} w ON w.id = b.origin_work_id
        LEFT JOIN ${threads} t ON t.id = b.origin_root_thread_id
        WHERE (w.id IS NOT NULL OR t.id IS NOT NULL)
        ORDER BY p.document_id::text, 3, 2
      `);
      for (const row of pending) {
        const documentId = row.document_id as DocumentId;
        const retaining = held.get(documentId) ?? [];
        retaining.push({ id: row.id, name: row.name });
        held.set(documentId, retaining);
      }
    }
    const addressesById = new Map(addresses.map((address) => [address.documentId, address]));

    return result.flatMap((row): DocumentTrashEntry[] => {
      const documentId = row.documentId as DocumentId;
      const address = addressesById.get(documentId);
      if (!address || !row.trashedAt) return [];
      return [
        {
          documentId,
          name: row.name,
          scheme: address.scheme,
          formerPath: address.path,
          removal: serializeRemovalIdentity({
            time: row.trashedAt,
            locationVersion: row.locationVersion,
          }),
          // The delete record's author lives in the list, which this reader does not open.
          actor: null,
          retention: held.has(documentId)
            ? { kind: "held", works: held.get(documentId) ?? [] }
            : { kind: "scheduled", purgeAt: deletionPurgeAt(row.trashedAt).toISOString() },
        },
      ];
    });
  };

  /**
   * Releases the documents' content, after their rows are gone from every view: the journal and
   * what hung on the text, then the row is marked and loses its bytes. The caller holds the
   * documents' locks and has closed their drafts.
   */
  async function release(documentIds: DocumentId[]): Promise<Released> {
    const tx = currentDrizzleDb(deps.db);
    if (documentIds.length === 0) return { documentIds, storageUrls: [] };
    const held = await tx
      .select({ id: documents.id, storageUrl: documents.storageUrl })
      .from(documents)
      .where(and(inArray(documents.id, documentIds), isNull(documents.contentPurgedAt)));
    const ids = held.map(({ id }) => id as DocumentId);
    await releaseDocumentContent(deps.db, ids);
    const purgedAt = new Date();
    await tx
      .update(documents)
      .set({
        contentPurgedAt: purgedAt,
        storageUrl: null,
        mimeType: null,
        sizeBytes: null,
        metadata: {},
        updatedAt: purgedAt,
      })
      .where(inArray(documents.id, ids));
    return {
      documentIds: ids,
      storageUrls: held.flatMap(({ storageUrl }) => (storageUrl ? [storageUrl] : [])),
    };
  }

  /**
   * Empties one Trash entry: a `purge` record naming the delete, then the content of the
   * documents it took. The whole subtree goes in one submission (a folder purged while a child's
   * row stands fails the deferred foreign key). Null when the entry is not there, a node outside
   * it stands inside it, or a Work can still bring it back: retention waits.
   *
   * What holds a document is asked before the purge, under the list's key: the purge removes the
   * rows the question reads. The first submission makes nothing (a read under the key, which the
   * transaction keeps), the second purges.
   */
  async function purgeEntry(list: TreeList, deleteId: string): Promise<Released | null> {
    try {
      return await runInDrizzleTransaction(deps.db, async () => {
        const { result: taken } = await deps.tree.submit({
          lists: [list],
          make: ([{ writer }]) => {
            const view = writer.view(LIVE);
            const entry = view.trash.find((each) => each.id === deleteId || each.from === deleteId);
            if (!entry) throw new TreeRefusal("gone");
            const nodes = new Set([entry.node, ...entry.cascade]);
            const standing = [...nodes].some((id) =>
              descendantsOf(view, id).some(
                (below) => !nodes.has(below) && !view.nodes.get(below)?.purged,
              ),
            );
            if (standing || unsettledOn(writer.doc, nodes)) throw new TreeRefusal("held");
            return {
              entry: { id: entry.id, node: entry.node },
              documentIds: [...nodes].filter(
                (id) => view.nodes.get(id)?.kind !== "folder",
              ) as DocumentId[],
            };
          },
        });
        if ((await deps.drafts.settle(taken.documentIds)) === "pending")
          throw new TreeRefusal("held");
        await deps.tree.submit({
          lists: [list],
          make: ([{ writer }]) => {
            writer.purge("system", taken.entry);
          },
        });
        return release(taken.documentIds);
      });
    } catch (cause) {
      if (cause instanceof TreeRefusal) return null;
      throw cause;
    }
  }

  /**
   * The Trash entries whose nodes have all been in Trash since `cutoff`, oldest first. The page
   * key is the database's own text of the time: a JS date would drop its microseconds and the
   * same entry would come back as the next page.
   */
  async function dueEntries(cutoff: Date, after: { at: string; id: string } | undefined) {
    const rowsDue = await currentDrizzleDb(deps.db).execute<{
      deleteId: string;
      projectId: string | null;
      userId: string | null;
      at: string;
    }>(sql`
      SELECT t.trash_record AS "deleteId", p.id::text AS "projectId", u.id::text AS "userId",
        min(t.trashed_at)::text AS "at"
      FROM tree_nodes t
        JOIN context_sources cs ON cs.id = t.context_source_id
        LEFT JOIN projects p ON p.tree_list_id = t.list_id
        LEFT JOIN users u ON u.tree_list_id = t.list_id
      WHERE t.trash_record IS NOT NULL
      GROUP BY t.list_id, t.trash_record, p.id, p.deleted_at, u.id
      HAVING max(t.trashed_at) <= ${cutoff.toISOString()}::timestamptz
        AND bool_and(cs.deleted_at IS NULL) AND p.deleted_at IS NULL
        ${after ? sql`AND (min(t.trashed_at), t.trash_record) > (${after.at}::timestamptz, ${after.id})` : sql``}
      ORDER BY min(t.trashed_at), t.trash_record
      LIMIT ${ENTRY_PAGE}`);
    return rowsDue.map((row) => ({
      deleteId: row.deleteId,
      at: row.at,
      list: (row.projectId
        ? { kind: "project", projectId: row.projectId }
        : { kind: "account", userId: row.userId as string }) as TreeList,
    }));
  }

  /**
   * A document no view shows: its drafted create was discarded, or refused and not kept, and
   * it has been that way since `cutoff`. It has no node, so there is no record to append; the
   * lists that can reshow it (an Undo of the Discard) are locked while its content is released.
   */
  async function purgeUnviewed(documentId: DocumentId, cutoff: Date): Promise<Released | null> {
    const tx = () => currentDrizzleDb(deps.db);
    try {
      return await runInDrizzleTransaction(deps.db, async () => {
        const [owner] = await tx().execute<{ project: string; user: string }>(sql`
          SELECT p.id::text AS project, p.user_id::text AS "user"
          FROM documents d JOIN projects p ON p.id = d.project_id
          WHERE d.id = ${documentId}::uuid`);
        if (!owner) return null;
        // Both lists that can reshow it, under their keys: a read of what is still unsettled.
        await deps.tree.submit({
          lists: [
            { kind: "project", projectId: owner.project },
            { kind: "account", userId: owner.user },
          ],
          make: (copies) => {
            if (copies.some(({ writer }) => unsettledOn(writer.doc, new Set([documentId]))))
              throw new TreeRefusal("held");
          },
        });
        const [still] = await tx()
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, documentId), unviewedBefore(cutoff)))
          .limit(1);
        if (!still) return null;
        if ((await deps.drafts.settle([documentId])) === "pending") return null;
        return release([documentId]);
      });
    } catch (cause) {
      if (cause instanceof TreeRefusal) return null;
      throw cause;
    }
  }

  function unviewedBefore(cutoff: Date) {
    return and(
      isNull(documents.contentPurgedAt),
      lte(documents.inNoViewSince, cutoff),
      notExists(
        currentDrizzleDb(deps.db)
          .select({ one: sql`1` })
          .from(treeNodes)
          .where(eq(treeNodes.id, documents.id)),
      ),
      notExists(
        currentDrizzleDb(deps.db)
          .select({ one: sql`1` })
          .from(branchTreeNodes)
          .where(eq(branchTreeNodes.id, documents.id)),
      ),
    );
  }

  return {
    async retained(projectId, documentIds): Promise<ReadonlySet<DocumentId>> {
      if (documentIds.length === 0) return new Set();
      const found = await rows(projectId, documentIds);
      return new Set(found.map(({ documentId }) => documentId as DocumentId));
    },
    async list(projectId): Promise<readonly DocumentTrashEntry[]> {
      return entries(await rows(projectId));
    },
    async read(projectId, documentId): Promise<GetDocumentTrashResponse | null> {
      const entry = (await entries(await rows(projectId, [documentId])))[0];
      if (!entry) return null;
      return { ...entry, markdown: await deps.readMarkdown(documentId) };
    },
    async wasPurged(projectId, documentId): Promise<boolean> {
      const [row] = await currentDrizzleDb(deps.db)
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(sourceProjects, eq(sourceProjects.id, documents.projectId))
        .innerJoin(requestProjects, eq(requestProjects.id, projectId))
        .where(
          and(
            eq(documents.id, documentId),
            isNull(requestProjects.deletedAt),
            isNotNull(documents.contentPurgedAt),
            sql`(${eq(sourceProjects.id, requestProjects.id)}
              OR (${eq(sourceProjects.userId, requestProjects.userId)} AND ${sourceProjects.isPersonal}))`,
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    async purge(): Promise<number> {
      const cutoff = deletionPurgeCutoff(new Date());
      let count = 0;
      const finish = async (released: Released | null) => {
        if (!released) return;
        count += released.documentIds.length;
        if (released.storageUrls.length) await objects.storageUrls(released.storageUrls);
      };
      let after: { at: string; id: string } | undefined;
      while (count < DOCUMENT_PURGE_BATCH_LIMIT) {
        const due = await dueEntries(cutoff, after);
        const last = due.at(-1);
        if (!last) break;
        after = { at: last.at, id: last.deleteId };
        for (const entry of due) {
          if (count >= DOCUMENT_PURGE_BATCH_LIMIT) break;
          await finish(await purgeEntry(entry.list, entry.deleteId));
        }
      }
      while (count < DOCUMENT_PURGE_BATCH_LIMIT) {
        const candidates = await currentDrizzleDb(deps.db)
          .select({ id: documents.id })
          .from(documents)
          .where(unviewedBefore(cutoff))
          .orderBy(asc(documents.inNoViewSince), asc(documents.id))
          .limit(DOCUMENT_PURGE_BATCH_LIMIT - count);
        if (candidates.length === 0) break;
        const before = count;
        for (const { id } of candidates)
          await finish(await purgeUnviewed(id as DocumentId, cutoff));
        // A candidate that waits stays a candidate: stop when a pass releases nothing.
        if (count === before) break;
      }
      return count;
    },
  };
}
