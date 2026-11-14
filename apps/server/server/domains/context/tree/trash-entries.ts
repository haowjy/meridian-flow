/**
 * Trash as the tree gives it, per view (design section 2): one entry for each `delete` in force
 * (a folder with what that delete took, a document on its own), restored whole; and the tree half
 * of a Discard's entry, which the change set's restore command calls. Live and a Work's draft
 * differ the way their trees do: a Work that drafted a delete sees the entry, live does not.
 */
import type { Database } from "@meridian/database";
import { treeNodes } from "@meridian/database/schema";
import {
  type Actor,
  type DiscardedBy,
  discardedBy,
  listRecords,
  type NodeKind,
  restoreDiscard,
  type TreeRecord,
  type View,
} from "@meridian/project-tree";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../ports/tree-list-store.js";
import { pathNames } from "./names-shown.js";

export type TrashTreeEntry = {
  /** The delete record's id: what the entry is keyed by and restored by. */
  id: string;
  node: string;
  kind: NodeKind;
  /** Its name and the folders above it as they stood when it was deleted. */
  name: string;
  path: string[];
  source: string;
  deletedBy: Actor | undefined;
  /** When the server admitted the delete; null in a Work's draft, where the delete is pending. */
  trashedAt: Date | null;
  /** What the delete still takes, the node itself among them. */
  took: { documents: number; files: number; folders: number };
  nodes: string[];
};

export type DiscardedTree = {
  records: TreeRecord[];
  /** The nodes the Discard's records created, with where they stood. */
  created: Array<{ node: string; kind: NodeKind; name: string; path: string[] }>;
  restored: boolean;
};

export type TrashEntries = {
  /** The entries of a view across the lists, newest first (entries with no time last). */
  list(input: { lists: readonly TreeList[]; view: View }): Promise<TrashTreeEntry[]>;
  /** Restores one entry whole: the delete it names and what it took, nothing else. */
  restore(input: {
    lists: readonly TreeList[];
    view: View;
    by: Actor;
    entry: string;
  }): Promise<"restored" | "unknown">;
};

export function createTrashEntries(deps: {
  db: Database;
  store: Pick<TreeListStore, "read" | "submit">;
}): TrashEntries {
  return {
    async list({ lists, view }) {
      const found = await deps.store.read({
        lists,
        view: (writers) =>
          writers.flatMap(({ writer }) => {
            const projection = writer.view(view);
            const actors = new Map(
              listRecords(writer.doc).map((record) => [record.id, record.actor]),
            );
            return projection.trash.flatMap((entry): TrashTreeEntry[] => {
              const node = projection.nodes.get(entry.node);
              if (!node) return [];
              const nodes = [entry.node, ...entry.cascade].filter((id) => projection.nodes.has(id));
              const kinds = nodes.map((id) => projection.nodes.get(id)?.kind);
              return [
                {
                  id: entry.id,
                  node: entry.node,
                  kind: node.kind,
                  name: node.displayName,
                  path: pathNames(projection, entry.node),
                  source: node.source,
                  deletedBy: actors.get(entry.from ?? entry.id),
                  trashedAt: null,
                  took: {
                    documents: kinds.filter((kind) => kind === "document").length,
                    files: kinds.filter((kind) => kind === "file").length,
                    folders: kinds.filter((kind) => kind === "folder").length,
                  },
                  nodes,
                },
              ];
            });
          }),
      });
      // The time a live delete was admitted is on the node's row; a drafted delete has none yet.
      if (view.draft === null && found.length > 0) {
        const rows = await currentDrizzleDb(deps.db)
          .select({ id: treeNodes.id, at: treeNodes.trashedAt })
          .from(treeNodes)
          .where(
            inArray(
              treeNodes.id,
              found.map((entry) => entry.node),
            ),
          );
        const at = new Map(rows.map((row) => [row.id as string, row.at]));
        for (const entry of found) entry.trashedAt = at.get(entry.node) ?? null;
      }
      return found.sort((a, b) => (b.trashedAt?.getTime() ?? 0) - (a.trashedAt?.getTime() ?? 0));
    },

    async restore({ lists, view, by, entry }) {
      const { result } = await deps.store.submit({
        lists,
        make: (writers) => {
          for (const { writer } of writers) {
            const restored = writer.restoreEntry(view, by, entry);
            if (restored !== "unknown") return "restored" as const;
          }
          return "unknown" as const;
        },
      });
      return result;
    },
  };
}

/**
 * The tree half of a Discard's Trash entry (design section 5): what the command settled. It
 * answers for a restore of a Discard too (the records the restore overrode and settled under
 * itself), and answers empty, not an error, for a command that discarded no tree records.
 */
export async function discardedTree(
  store: Pick<TreeListStore, "read">,
  list: TreeList,
  command: string,
): Promise<DiscardedTree> {
  return store.read({
    lists: [list],
    view: ([{ writer }]): DiscardedTree => {
      const found: DiscardedBy = discardedBy(writer.doc, command);
      const projection = writer.view({ draft: null });
      // A node the Discard left in no live view is not in this projection's live nodes only when purged.
      const created = found.created.flatMap((id) => {
        const node = projection.nodes.get(id);
        return node
          ? [{ node: id, kind: node.kind, name: node.displayName, path: pathNames(projection, id) }]
          : [];
      });
      return { records: found.records, created, restored: found.restored };
    },
  });
}

/**
 * The tree half of restoring a Discard: fresh pending copies on `branchId`, in the caller's
 * command transaction (it joins it and takes the list's key, which sorts after the Work, branch
 * and draft rows). `superseded` when it was restored already or discarded nothing.
 */
export async function restoreDiscardedTree(
  store: Pick<TreeListStore, "submit">,
  list: TreeList,
  input: { command: string; by: Actor; branchId: string; restoreCommand: string },
): Promise<{ copies: TreeRecord[]; leftOut: TreeRecord[] } | "superseded"> {
  const { result } = await store.submit({
    lists: [list],
    make: ([{ writer }]) =>
      restoreDiscard(writer, input.command, input.by, input.branchId, input.restoreCommand),
  });
  return result;
}
