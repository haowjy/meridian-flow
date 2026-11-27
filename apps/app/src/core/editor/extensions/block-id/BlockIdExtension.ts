import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { fixBlockIds } from "./fix-block-ids";

const BLOCK_ID_TYPES = [
  "paragraph",
  "code_block",
  "table",
  "table_row",
  "table_cell",
  "table_header",
  "figure",
  "horizontal_rule",
  "jsx_leaf",
  "jsx_container",
];

export const BlockIdExtension = Extension.create({
  name: "blockId",

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_ID_TYPES,
        attributes: {
          id: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
            renderHTML: (attributes: Record<string, unknown>) =>
              typeof attributes.id === "string" ? { "data-block-id": attributes.id } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("meridianBlockIds"),
        filterTransaction: (transaction, state) => {
          fixBlockIds(transaction, state);
          return true;
        },
      }),
    ];
  },
});
