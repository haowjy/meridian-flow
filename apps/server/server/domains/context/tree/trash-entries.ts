/**
 * The tree half of a Discard's Trash entry, which the change set's restore command calls: what
 * the Discard settled, and its fresh pending copies when it is restored. The Trash list itself is
 * `drizzle-document-trash.ts`.
 */
import {
  type Actor,
  type DiscardedBy,
  discardedBy,
  isSourceRoot,
  type NodeKind,
  nameSet,
  restoreDiscard,
  type TreeRecord,
} from "@meridian/project-tree";
import type { TreeList, TreeListStore } from "../ports/tree-list-store.js";
import { pathNames } from "./names-shown.js";

export type DiscardedTree = {
  records: TreeRecord[];
  /** The nodes the Discard's records created, with where they stood. */
  created: Array<{ node: string; kind: NodeKind; name: string; path: string[] }>;
  restored: boolean;
};

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
      const live = writer.view({ draft: null });
      // The nodes the Discard created exist in no live view: their names and places are what
      // its own records say (the create, then any rename or move the Discard also held).
      const made = new Map<string, { kind: NodeKind; name: string; parent: string }>();
      for (const record of found.records) {
        if (record.type === "create")
          made.set(record.node, { kind: record.kind, name: record.name, parent: record.parent });
        const node = made.get(record.node);
        const named = nameSet(record);
        if (named !== undefined && node) node.name = named;
        if (record.type === "move" && node) node.parent = record.parent;
      }
      const pathOf = (id: string): string[] => {
        const names: string[] = [];
        for (let at = made.get(id); at; at = made.get(at.parent)) {
          names.unshift(at.name);
          if (!made.has(at.parent))
            names.unshift(...(isSourceRoot(at.parent) ? [] : pathNames(live, at.parent)));
        }
        return names;
      };
      const created = found.created.flatMap((id) => {
        const node = made.get(id);
        return node ? [{ node: id, kind: node.kind, name: node.name, path: pathOf(id) }] : [];
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
