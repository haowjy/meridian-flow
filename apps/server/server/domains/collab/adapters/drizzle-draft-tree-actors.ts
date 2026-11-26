import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { pendingRecords, recordsOfItem } from "@meridian/project-tree";
import { parseActor } from "../../context/adapters/context-fs/tree-writes.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { treeListsOfDraft } from "./drizzle-draft-tree-lists.js";

export function createDrizzleDraftTreeActors(db: Database, treeLists: Pick<TreeListStore, "read">) {
  return async function treeActors(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, readonly string[]>> {
    const lists = await treeListsOfDraft(db, draftId);
    const perList = await treeLists.read({
      lists,
      view: (copies) =>
        copies.map(({ writer }) => ({
          pending: pendingRecords(writer.doc, draftId),
          projection: writer.view({ draft: draftId }),
        })),
    });
    const candidates =
      documentIds ??
      ([...new Set(perList.flatMap(({ pending }) => pending.map((r) => r.node)))] as DocumentId[]);
    const actors = new Map<DocumentId, string[]>();
    for (const documentId of candidates) {
      const chats: string[] = [];
      const records = perList.flatMap(({ pending, projection }) =>
        recordsOfItem(projection, pending, documentId),
      );
      for (const record of records.reverse()) {
        const who = parseActor(record.actor);
        if (who?.kind === "agent" && who.chatId && !chats.includes(who.chatId))
          chats.push(who.chatId);
      }
      if (chats.length) actors.set(documentId, chats);
    }
    return actors;
  };
}
