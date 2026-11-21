/**
 * The tree half of a Work's Discard: its pending records settled discarded in every list it
 * spans. The press's Discard and Work purge's disposal (`drizzle-work-disposal.ts`) run it.
 */
import type { DraftId, UserId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { discardDraft, pendingRecords, recordsOfItem } from "@meridian/project-tree";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { treeListsOfDraft } from "./drizzle-draft-tree-lists.js";

/**
 * Settles the Work's pending tree records discarded, in every list it spans. With `documents`,
 * the records of those documents' items (and what stands on a node they create); without, all
 * of them. With `trash` (a press), what the Work created goes to live's Trash (`discardDraft`).
 * Returns the documents that had records.
 */
export async function discardTreeRecords(
  db: Database,
  deps: { treeLists: Pick<TreeListStore, "submit"> },
  input: {
    draftId: DraftId;
    userId?: UserId;
    commandId: string;
    documents?: readonly DocumentId[];
    trash?: boolean;
  },
): Promise<Set<DocumentId>> {
  const had = new Set<DocumentId>();
  const by = input.userId ? `user:${input.userId}` : "system";
  const { result } = await deps.treeLists.submit({
    lists: await treeListsOfDraft(db, input.draftId),
    make: (copies) =>
      copies.flatMap(({ writer }) => {
        const pending = pendingRecords(writer.doc, input.draftId);
        const draft = writer.view({ draft: input.draftId });
        const items = input.documents;
        const only = items
          ? [...new Set(items.flatMap((id) => recordsOfItem(draft, pending, id)))]
          : pending;
        const discarded = new Set(
          discardDraft(
            writer,
            input.draftId,
            by,
            input.commandId,
            items ? only.map((r) => r.id) : undefined,
            { trash: input.trash === true },
          ),
        );
        // A discarded delete had what it covered in the Work's view, not what its author saw.
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
  return had;
}
