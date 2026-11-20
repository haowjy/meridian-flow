/**
 * The tree half of a Discard's Trash entry: what the Discard settled. The Trash list itself is
 * `drizzle-document-trash.ts`.
 */
import {
  type DiscardedBy,
  discardedBy,
  isSourceRoot,
  type NodeKind,
  type TreeRecord,
} from "@meridian/project-tree";
import type { TreeList, TreeListStore } from "../ports/tree-list-store.js";
import { pathNames } from "./names-shown.js";

export type DiscardedTree = {
  records: TreeRecord[];
  /** The nodes the Discard's records created, with where they stood. */
  created: Array<{ node: string; kind: NodeKind; name: string; path: string[] }>;
};

/**
 * The tree half of Discard Trash entries (design section 5): what each command settled, read
 * once from the list, in the order asked. It answers empty, not an error, for a command that
 * discarded no tree records.
 */
export async function discardedTree(
  store: Pick<TreeListStore, "read">,
  list: TreeList,
  commands: readonly string[],
): Promise<DiscardedTree[]> {
  return store.read({
    lists: [list],
    view: ([{ writer }]): DiscardedTree[] => {
      const live = writer.view({ draft: null });
      return commands.map((command) => {
        const found: DiscardedBy = discardedBy(writer.doc, command);
        // The nodes the Discard created exist in no live view: their names and places are what
        // its own records say (the create, then any rename or move the Discard also held).
        const made = new Map<string, { kind: NodeKind; name: string; parent: string }>();
        for (const record of found.records) {
          if (record.type === "create")
            made.set(record.node, { kind: record.kind, name: record.name, parent: record.parent });
          const node = made.get(record.node);
          if (record.type === "rename" && node) node.name = record.name;
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
        return { records: found.records, created };
      });
    },
  });
}
