/** The chats behind a Work's pending tree records, for the review list's `actorThreadIds`. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { readPendingTreeRecords, recordsOfItem } from "./drizzle-branch-tree-lists.js";

/**
 * A document's chats, the latest record's first: a record's actor is `agent:<chat>/<turn>` for a
 * chat's tool call and `user:<id>` for a writer, who names no chat.
 */
export function createDrizzleBranchTreeActors(
  db: Database,
  treeLists: Pick<TreeListStore, "read">,
) {
  return async function treeActors(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, readonly string[]>> {
    const pending = (await readPendingTreeRecords(db, treeLists, branchId)).map(
      ({ record }) => record,
    );
    const candidates = documentIds ?? ([...new Set(pending.map((r) => r.node))] as DocumentId[]);
    const actors = new Map<DocumentId, string[]>();
    for (const documentId of candidates) {
      const chats: string[] = [];
      for (const record of recordsOfItem(pending, documentId).reverse()) {
        const chat = /^agent:([^/]+)\//.exec(record.actor)?.[1];
        if (chat && !chats.includes(chat)) chats.push(chat);
      }
      if (chats.length) actors.set(documentId, chats);
    }
    return actors;
  };
}
