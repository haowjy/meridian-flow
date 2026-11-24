/** Drizzle adapter for restorable document trash and retention: emptying Trash, and the purge window. */
import { type DocumentId, type ProjectId, serializeRemovalIdentity } from "@meridian/contracts";
import type { DocumentTrashEntry, TrashEntryFacts } from "@meridian/contracts/protocol";
import { deletionPurgeAt, deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  draftTreeNodes,
  projects,
  threads,
  treeNodes,
  works,
} from "@meridian/database/schema";
import {
  descendantsOf,
  LIVE,
  lastSettlements,
  listRecords,
  settlementsOf,
} from "@meridian/project-tree";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { LoroDoc } from "loro-crdt";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import { createObjectRelease, type ObjectStorePort } from "../../storage/index.js";
import { trashActorsOf } from "../adapters/trash-removals.js";
import type { DocumentPurgeDisposal, DocumentTrash } from "../ports/document-trash.js";
import { type TreeList, type TreeListStore, TreeRefusal } from "../ports/tree-list-store.js";
import {
  type DocumentContentEnd,
  type Released,
  releaseDocumentContent,
} from "./release-document-content.js";
import { retentionHolds } from "./retention-holds.js";
import {
  ownedByRequestSql,
  ownerFrom,
  ownerProjectIdSql,
  sourceOwnerProjectId,
} from "./source-owner.js";
import { loadDocumentAddresses, ownerOfDocument } from "./tree-addresses.js";

/** Documents released in one run: bounds how long one run holds the database. */
const DOCUMENT_PURGE_BATCH_LIMIT = 100;
const ENTRY_PAGE = 100;
const sourceProjects = alias(projects, "document_trash_source_projects");
const requestProjects = alias(projects, "document_trash_request_projects");

/** A project's Trash holds its own sources' nodes and its account's home folder's. */
function projectTrashMember() {
  return ownedByRequestSql(
    { projectId: sourceOwnerProjectId, userId: sql`${contextSources.userId}` },
    { projectId: sql`${requestProjects.id}`, accountId: sql`${requestProjects.userId}` },
  );
}

/** An unsettled drafted record on one of the nodes, or one that creates or moves under them. */
function unsettledOn(doc: LoroDoc, nodes: ReadonlySet<string>): boolean {
  const settled = settlementsOf(doc);
  return listRecords(doc).some(
    (record) =>
      record.draft !== null &&
      !settled.has(record.id) &&
      (nodes.has(record.node) ||
        ((record.type === "create" || record.type === "move") && nodes.has(record.parent))),
  );
}

export function createDrizzleDocumentTrash(deps: {
  db: Database;
  objectStore: Pick<ObjectStorePort, "delete">;
  eventSink: EventSink;
  purges: DocumentPurgeDisposal;
  /** What collab ends with a purged document's content. */
  collab: DocumentContentEnd;
  tree: Pick<TreeListStore, "submit">;
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
        trashedBy: treeNodes.trashedBy,
      })
      .from(treeNodes)
      .innerJoin(documents, eq(documents.id, treeNodes.id))
      .innerJoin(contextSources, eq(contextSources.id, treeNodes.contextSourceId))
      .leftJoin(works, eq(works.id, contextSources.workId))
      .leftJoin(sourceProjects, eq(sourceProjects.id, sourceOwnerProjectId))
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

  /**
   * The Trash entries of a project, newest first: each node a delete took whose folder that
   * delete did not take too, so a folder stands for what its delete took and a document deleted
   * on its own is its own entry. A document purged by a Discard is in no entry.
   */
  const entryRows = (projectId: ProjectId) =>
    currentDrizzleDb(deps.db).execute<{
      id: string;
      trash_record: string;
      trashed_at: Date | string;
      location_version: string;
      trashed_by: string | null;
    }>(sql`
      SELECT t.id::text AS id, t.trash_record,
        t.trashed_at, t.location_version, t.trashed_by
      FROM ${treeNodes} t
        LEFT JOIN ${treeNodes} p ON p.id = t.parent_id
        LEFT JOIN ${documents} d ON d.id = t.id
        JOIN ${contextSources} cs ON cs.id = t.context_source_id
        LEFT JOIN ${works} w ON w.id = cs.work_id
        LEFT JOIN ${projects} sp ON sp.id = ${ownerProjectIdSql("cs", "w")}
        JOIN ${projects} rp ON rp.id = ${projectId}::uuid
      WHERE t.trash_record IS NOT NULL AND t.trashed_at IS NOT NULL
        AND (p.id IS NULL OR p.trash_record IS DISTINCT FROM t.trash_record)
        AND (t.kind = 'folder' OR (t.kind = 'document' AND d.id IS NOT NULL AND d.content_purged_at IS NULL))
        AND cs.deleted_at IS NULL AND sp.deleted_at IS NULL AND rp.deleted_at IS NULL
        AND ${ownedByRequestSql({ projectId: sql`sp.id`, userId: sql`cs.user_id` }, { projectId: sql`rp.id`, accountId: sql`rp.user_id` })}
      ORDER BY t.trashed_at DESC, t.id DESC`);

  /** The Works whose changes keep each document in Trash past its window. */
  const holdsOf = async (ids: readonly DocumentId[]) => {
    const held = new Map<DocumentId, Array<{ id: string; name: string }>>();
    if (ids.length === 0) return held;
    const pending = await currentDrizzleDb(deps.db).execute<{
      document_id: string;
      id: string;
      name: string;
    }>(sql`
      SELECT DISTINCT p.document_id::text,
             coalesce(w.id, t.id)::text AS id, coalesce(w.name, nullif(t.title, ''), 'A chat') AS name
      FROM (${retentionHolds(ids)}) p
      JOIN drafts d ON d.id = p.draft_id
      LEFT JOIN ${works} w ON w.id = d.work_id
      LEFT JOIN ${threads} t ON t.draft_id = p.draft_id AND d.work_id IS NULL
      WHERE (w.id IS NOT NULL OR t.id IS NOT NULL)
      ORDER BY p.document_id::text, 3, 2
    `);
    for (const row of pending) {
      const documentId = row.document_id as DocumentId;
      const retaining = held.get(documentId) ?? [];
      retaining.push({ id: row.id, name: row.name });
      held.set(documentId, retaining);
    }
    return held;
  };

  const retentionOf = (
    trashedAt: Date,
    works: ReadonlyArray<{ id: string; name: string }>,
  ): DocumentTrashEntry["retention"] =>
    works.length > 0
      ? { kind: "held", works: [...works] }
      : { kind: "scheduled", purgeAt: deletionPurgeAt(trashedAt).toISOString() };

  const entries = async (
    result: Awaited<ReturnType<typeof rows>>,
  ): Promise<DocumentTrashEntry[]> => {
    const ids = result.map(({ documentId }) => documentId as DocumentId);
    const addresses = await loadDocumentAddresses(deps.db, { ids });
    const held = await holdsOf(ids);
    const addressesById = new Map(addresses.map((address) => [address.documentId, address]));
    const actorOf = await trashActorsOf(
      deps.db,
      result.map((row) => row.trashedBy),
    );

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
          actor: actorOf(row.trashedBy),
          retention: retentionOf(row.trashedAt, held.get(documentId) ?? []),
        },
      ];
    });
  };

  async function listEntries(projectId: ProjectId): Promise<TrashEntryFacts[]> {
    const roots = await entryRows(projectId);
    if (roots.length === 0) return [];
    // What each folder's delete took: its documents count, and hold it while a Work has changes.
    const taken = await currentDrizzleDb(deps.db).execute<{ trash_record: string; id: string }>(sql`
      SELECT t.trash_record, t.id::text AS id
      FROM ${treeNodes} t JOIN ${documents} d ON d.id = t.id
      WHERE t.kind = 'document' AND d.content_purged_at IS NULL
        AND t.trash_record IN (${sql.join(
          roots.map((root) => sql`${root.trash_record}`),
          sql`, `,
        )})`);
    const documentsOf = new Map<string, DocumentId[]>();
    for (const row of taken)
      documentsOf.set(row.trash_record, [
        ...(documentsOf.get(row.trash_record) ?? []),
        row.id as DocumentId,
      ]);
    const held = await holdsOf(taken.map((row) => row.id as DocumentId));
    const actorOf = await trashActorsOf(
      deps.db,
      roots.map((root) => root.trashed_by),
    );
    return roots.map((root) => {
      const trashedAt = new Date(root.trashed_at);
      const works = new Map(
        (documentsOf.get(root.trash_record) ?? [])
          .flatMap((id) => held.get(id) ?? [])
          .map((work) => [work.id, work]),
      );
      return {
        nodeId: root.id,
        removal: serializeRemovalIdentity({
          time: trashedAt,
          locationVersion: BigInt(root.location_version),
        }),
        actor: actorOf(root.trashed_by),
        retention: retentionOf(trashedAt, [...works.values()]),
      };
    });
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
              nodes: [...nodes],
              documentIds: [...nodes].filter(
                (id) => view.nodes.get(id)?.kind !== "folder",
              ) as DocumentId[],
            };
          },
        });
        if ((await deps.purges.settle(taken.documentIds)) === "pending")
          throw new TreeRefusal("held");
        await deps.tree.submit({
          lists: [list],
          make: ([{ writer }]) => {
            // The records admitted since the first submission may have put a node inside:
            // the purge names exactly what this one found, and the replay rescues the rest.
            writer.purge("system", taken.entry, taken.nodes);
          },
        });
        return releaseDocumentContent(deps.db, deps.collab, taken.documentIds);
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
      list: ownerFrom(row),
    }));
  }

  /**
   * A document no view shows: its drafted create was discarded, or refused and not kept, and
   * it has been that way since `cutoff`. It has no node in any view, so the purge record names its
   * create's Discard; the lists that can reshow it (an Undo of the Discard) are locked while its
   * content is released.
   */
  async function purgeUnviewed(documentId: DocumentId, cutoff: Date): Promise<Released | null> {
    const tx = () => currentDrizzleDb(deps.db);
    try {
      return await runInDrizzleTransaction(deps.db, async () => {
        const owner = await ownerOfDocument(tx(), documentId);
        if (!owner) return null;
        // Its owner's list holds its create (no view shows it, so nothing moved it to another
        // list) and is the one an Undo of the Discard reshows it from: a read of what is still
        // unsettled, under the list's key.
        await deps.tree.submit({
          lists: [owner],
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
        if ((await deps.purges.settle([documentId])) === "pending") return null;
        // The list that holds its create says the content is gone: the browsers keeping a copy
        // of a Discarded document delete it on this record, the one fact they can trust.
        await deps.tree.submit({
          lists: [owner],
          make: (copies) => {
            for (const { writer } of copies) {
              const create = listRecords(writer.doc).find(
                (record) => record.type === "create" && record.node === documentId,
              );
              if (create)
                writer.purge(
                  "system",
                  {
                    id: lastSettlements(writer.doc).get(create.id)?.command ?? create.id,
                    node: documentId,
                  },
                  [documentId],
                );
            }
          },
        });
        return releaseDocumentContent(deps.db, deps.collab, [documentId]);
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
          .from(draftTreeNodes)
          .where(eq(draftTreeNodes.id, documents.id)),
      ),
    );
  }

  return {
    async retained(projectId, documentIds): Promise<ReadonlySet<DocumentId>> {
      if (documentIds.length === 0) return new Set();
      const found = await rows(projectId, documentIds);
      return new Set(found.map(({ documentId }) => documentId as DocumentId));
    },
    list: listEntries,
    async read(projectId, documentId): Promise<DocumentTrashEntry | null> {
      return (await entries(await rows(projectId, [documentId])))[0] ?? null;
    },
    async wasPurged(projectId, documentId): Promise<boolean> {
      const [row] = await currentDrizzleDb(deps.db)
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(requestProjects, eq(requestProjects.id, projectId))
        .where(
          and(
            eq(documents.id, documentId),
            isNull(requestProjects.deletedAt),
            isNotNull(documents.contentPurgedAt),
            ownedByRequestSql(
              { projectId: sql`${documents.projectId}`, userId: sql`${documents.userId}` },
              { projectId: sql`${requestProjects.id}`, accountId: sql`${requestProjects.userId}` },
            ),
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
      // One entry's purge is its own transaction: a failure stays logged each pass and does not
      // stop the entries after it.
      const isolated = async (id: string, run: () => Promise<Released | null>) => {
        try {
          return await run();
        } catch (error) {
          emitEvent(deps.eventSink, {
            level: "error",
            source: "context.document-purge",
            name: "purge.failed",
            payload: { id, error },
          });
          return null;
        }
      };
      let after: { at: string; id: string } | undefined;
      while (count < DOCUMENT_PURGE_BATCH_LIMIT) {
        const due = await dueEntries(cutoff, after);
        const last = due.at(-1);
        if (!last) break;
        after = { at: last.at, id: last.deleteId };
        for (const entry of due) {
          if (count >= DOCUMENT_PURGE_BATCH_LIMIT) break;
          await finish(
            await isolated(entry.deleteId, () => purgeEntry(entry.list, entry.deleteId)),
          );
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
          await finish(await isolated(id, () => purgeUnviewed(id as DocumentId, cutoff)));
        // A candidate that waits stays a candidate: stop when a pass releases nothing.
        if (count === before) break;
      }
      return count;
    },
  };
}
