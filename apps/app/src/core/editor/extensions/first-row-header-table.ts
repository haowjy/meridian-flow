/**
 * Enforces GFM-compatible table shape in the editor: row 0 is header cells only,
 * later rows are body cells only. Complements the schema's per-row homogeneity
 * rule — positional placement is not expressible on a single table_row type
 * without breaking prosemirror-tables / TipTap.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

function tableHasFirstRowHeader(table: PMNode): boolean {
  if (table.childCount === 0) return false;

  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex++) {
    const row = table.child(rowIndex);
    if (row.childCount === 0) return false;

    const cellType = row.child(0).type.name;
    for (let cellIndex = 1; cellIndex < row.childCount; cellIndex++) {
      if (row.child(cellIndex).type.name !== cellType) return false;
    }

    const expected = rowIndex === 0 ? "table_header" : "table_cell";
    if (cellType !== expected) return false;
  }

  return true;
}

export function firstRowHeaderTablePlugin() {
  return new Plugin({
    key: new PluginKey("firstRowHeaderTable"),
    filterTransaction(tr) {
      if (!tr.docChanged) return true;

      let valid = true;
      tr.doc.descendants((node) => {
        if (node.type.name === "table" && !tableHasFirstRowHeader(node)) {
          valid = false;
          return false;
        }
      });
      return valid;
    },
  });
}
