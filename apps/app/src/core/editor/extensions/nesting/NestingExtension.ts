/**
 * The editor half of the flat block model: the five nesting attributes on every block that
 * can sit in a list or a quote, the commands that write them, and the drawing. Lists have no
 * node of their own; see `nesting-commands.ts`.
 */
import { Extension, InputRule } from "@tiptap/core";
import {
  indent,
  type ListKindName,
  outdent,
  selectedSequence,
  selectionListKind,
  setList,
  unsetList,
} from "./nesting-commands";
import { nestingDrawPlugin } from "./nesting-draw";

/** The shared schema's `block` group nodes, which are the ones that carry nesting. */
const NESTED_TYPES = [
  "paragraph",
  "code_block",
  "table",
  "figure",
  "horizontal_rule",
  "jsx_leaf",
  "jsx_container",
  "blockquote",
];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nesting: {
      /** Makes the selected blocks items of this kind, or changes the kind of the items they are. */
      setList: (kind: ListKindName) => ReturnType;
      /** Lists the selected blocks, or returns them to body text when they already are such items. */
      toggleListKind: (kind: ListKindName) => ReturnType;
      indentList: () => ReturnType;
      outdentList: () => ReturnType;
    };
  }
}

/** `- `, `* `, `+ ` and `N. ` at the start of a block. */
function listInputRule(find: RegExp, kind: ListKindName): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      // Typed in an item of this kind already, a marker is just text.
      if (selectionListKind(selectedSequence(state.selection)) === kind) return null;
      const tr = state.tr.delete(range.from, range.to);
      setList(tr, kind);
      const start = kind === "ordered" ? Number(match[1]) : 1;
      if (start !== 1) {
        const sequence = selectedSequence(tr.selection);
        const at = sequence.from;
        tr.setNodeMarkup(sequence.positions[at], undefined, {
          ...sequence.blocks[at].attrs,
          start,
        });
      }
      return undefined;
    },
  });
}

export const NestingExtension = Extension.create({
  name: "nesting",

  addGlobalAttributes() {
    const stored = { default: null, rendered: false };
    return [
      {
        types: NESTED_TYPES,
        attributes: {
          path: stored,
          kind: stored,
          marker: stored,
          // The first number belongs to the list, so a block made by Enter does not copy it.
          start: { ...stored, keepOnSplit: false },
          loose: stored,
        },
      },
    ];
  },

  addCommands() {
    return {
      setList:
        (kind) =>
        ({ tr, dispatch }) => {
          const changed = setList(tr, kind);
          if (dispatch && changed) dispatch(tr);
          return changed;
        },
      toggleListKind:
        (kind) =>
        ({ tr, dispatch }) => {
          const active = selectionListKind(selectedSequence(tr.selection)) === kind;
          const changed = active ? unsetList(tr) : setList(tr, kind);
          if (dispatch && changed) dispatch(tr);
          return changed;
        },
      indentList:
        () =>
        ({ tr, dispatch }) => {
          const changed = indent(tr);
          if (dispatch && changed) dispatch(tr);
          return changed;
        },
      outdentList:
        () =>
        ({ tr, dispatch }) => {
          const changed = outdent(tr);
          if (dispatch && changed) dispatch(tr);
          return changed;
        },
    };
  },

  addInputRules() {
    return [listInputRule(/^\s*[-+*]\s$/, "bullet"), listInputRule(/^(\d{1,9})\.\s$/, "ordered")];
  },

  addProseMirrorPlugins() {
    return [nestingDrawPlugin()];
  },
});
