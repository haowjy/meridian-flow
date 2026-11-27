import type { DraftId, UserId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  discardDraft,
  pendingRecords,
  recordsOfItem,
  SYSTEM_ACTOR,
  userActor,
} from "@meridian/project-tree";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { treeListsOfDraft } from "./drizzle-draft-tree-lists.js";

export async function discardTreeRecords(
  db: Database,
  deps: { treeLists: Pick<TreeListStore, "submit"> },
  input: {
    draftId: DraftId;
    userId?: UserId;
    commandId: string;
    documents?: readonly DocumentId[];
    records?: readonly string[];
    trash?: boolean;
  },
): Promise<{ had: Set<DocumentId>; trashed: string[] }> {
  const had = new Set<DocumentId>();
  const trashed: string[] = [];
  const by = input.userId ? userActor(input.userId) : SYSTEM_ACTOR;
  const { result } = await deps.treeLists.submit({
    lists: await treeListsOfDraft(db, input.draftId),
    make: (copies) =>
      copies.flatMap(({ writer }) => {
        const pending = pendingRecords(writer.doc, input.draftId);
        const draft = writer.view({ draft: input.draftId });
        const only = input.documents
          ? [
              ...new Set(
                input.documents.flatMap((id) => recordsOfItem(draft, pending, id).map((r) => r.id)),
              ),
            ]
          : input.records;
        const done = discardDraft(writer, input.draftId, by, input.commandId, only, {
          trash: input.trash === true,
        });
        const discarded = new Set(done.discarded);
        trashed.push(...done.trashed);
        return pending
          .filter((record) => discarded.has(record.id))
          .map((record) => ({
            record,
            covered: draft.trash.find((entry) => entry.id === record.id)?.cascade ?? [],
          }));
      }),
  });
  for (const { record, covered } of result) {
    had.add(record.node as DocumentId);
    for (const id of covered) had.add(id as DocumentId);
  }
  return { had, trashed };
}
