/**
 * The editor half of the flat block model: the five nesting attributes on every block that
 * can sit in a list or a quote, the commands and keys that write them, the drawing, and the
 * clipboard. Lists and quotes have no node of their own; see `nesting-commands.ts`.
 */
import { Extension, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { getEditorChrome } from "../../chrome/ChromeKernelExtension";
import {
  indent,
  type ListKindName,
  outdent,
  quote,
  selectedSequence,
  selectionIsQuoted,
  selectionIsTaskList,
  selectionListKind,
  setList,
  setTaskList,
  unquote,
  unsetList,
} from "./nesting-commands";
import { nestingDrawPlugin } from "./nesting-draw";
import {
  backspaceInNesting,
  enterInNesting,
  toggleTaskAt,
  toggleTaskAtCaret,
} from "./nesting-keys";
import { copiedSlice } from "./nesting-landing";

/** The shared schema's `block` group nodes, which are the ones that carry nesting. */
const NESTED_TYPES = [
  "paragraph",
  "code_block",
  "table",
  "figure",
  "horizontal_rule",
  "jsx_leaf",
  "jsx_container",
];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nesting: {
      /** Makes the selected blocks items of this kind, or changes the kind of the items they are. */
      setList: (kind: ListKindName) => ReturnType;
      /** Lists the selected blocks, or returns them to body text when they already are such items. */
      toggleListKind: (kind: ListKindName) => ReturnType;
      /** Makes the selected blocks task items, or returns them to body text when they already are. */
      toggleTaskList: () => ReturnType;
      indentList: () => ReturnType;
      outdentList: () => ReturnType;
      /** Quotes the selected blocks, or takes them out of their innermost quote when every one is quoted. */
      toggleQuote: () => ReturnType;
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
      const sequence = selectedSequence(tr.selection);
      const at = sequence.from;
      const own = sequence.facts[at].steps.at(-1);
      // Typed after a list of the same kind, the block joins it and the number is not kept.
      if (start !== 1 && own?.opens) {
        tr.setNodeMarkup(sequence.positions[at], undefined, {
          ...sequence.blocks[at].attrs,
          start,
        });
      }
      return undefined;
    },
  });
}

/** `> ` at the start of a block quotes it, one quote deeper each time, as Markdown reads it. */
function quoteInputRule(): InputRule {
  return new InputRule({
    find: /^\s*>\s$/,
    handler: ({ state, range }) => {
      const tr = state.tr.delete(range.from, range.to);
      quote(tr);
      return undefined;
    },
  });
}

/** `[ ] ` and `[x] ` at the start of an item make it a task. */
function taskInputRule(): InputRule {
  return new InputRule({
    find: /^\[([ xX])\]\s$/,
    handler: ({ state, range, match }) => {
      const sequence = selectedSequence(state.selection);
      const facts = sequence.facts[sequence.from];
      const own = facts.steps.at(-1);
      if (own?.type !== "list" || !own.startsItem) return null;
      const tr = state.tr.delete(range.from, range.to);
      tr.setNodeMarkup(sequence.positions[sequence.from], undefined, {
        ...sequence.blocks[sequence.from].attrs,
        marker: match[1] === " " ? "todo" : "done",
      });
      return undefined;
    },
  });
}

/** True when a press at `clientX` falls in the block's marker gutter, where the box is drawn. */
function inMarkerGutter(element: HTMLElement, clientX: number): boolean {
  const rect = element.getBoundingClientRect();
  const gutter = Number.parseFloat(getComputedStyle(element).paddingInlineStart) || 0;
  return clientX >= rect.left && clientX < rect.left + gutter;
}

const stored = { default: null, rendered: false } as const;

/** A nesting attribute read from the `data-` attribute `flattenDom` writes on pasted HTML. */
function pasted(name: string, read: (value: string) => unknown = (value) => value) {
  return {
    ...stored,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute(`data-${name}`);
      return value === null ? null : read(value);
    },
  };
}

export const NestingExtension = Extension.create({
  name: "nesting",

  addGlobalAttributes() {
    return [
      {
        types: NESTED_TYPES,
        attributes: {
          path: pasted("path"),
          kind: pasted("kind"),
          marker: pasted("marker"),
          // The first number belongs to the list, so a block made by Enter does not copy it.
          start: { ...pasted("start", Number), keepOnSplit: false },
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
      toggleTaskList:
        () =>
        ({ tr, dispatch }) => {
          const active = selectionIsTaskList(selectedSequence(tr.selection));
          const changed = active ? unsetList(tr) : setTaskList(tr);
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
      toggleQuote:
        () =>
        ({ tr, dispatch }) => {
          const quoted = selectionIsQuoted(selectedSequence(tr.selection));
          const changed = quoted ? unquote(tr) : quote(tr);
          if (dispatch && changed) dispatch(tr);
          return changed;
        },
    };
  },

  addKeyboardShortcuts() {
    return { "Mod-Shift-b": () => this.editor.commands.toggleQuote() };
  },

  addInputRules() {
    return [
      listInputRule(/^\s*[-+*]\s$/, "bullet"),
      listInputRule(/^(\d{1,9})\.\s$/, "ordered"),
      quoteInputRule(),
      taskInputRule(),
    ];
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      nestingDrawPlugin(),
      new Plugin({
        key: new PluginKey("meridianNestingKeys"),
        // Through the kernel, like Tab: an open menu's Enter outranks a list's.
        view: () => {
          const release = getEditorChrome(editor)?.registerKeymap({
            id: "nesting",
            scope: "document",
            // Prose, in the document or a cell; a fence or an object keeps its own keys.
            appliesTo: (context) => context.owner === "document" || context.owner === "table-cell",
            bindings: {
              // A link the keyboard focused follows on Enter (`LinkSurfaceExtension`).
              Enter: (state, dispatch, view) =>
                (!view || view.dom.ownerDocument.activeElement === view.dom) &&
                enterInNesting(state, dispatch),
              // Right after `- ` or `1. `, Backspace gives the characters back instead.
              Backspace: (state, dispatch) =>
                !editor.can().undoInputRule() && backspaceInNesting(state, dispatch),
              "Mod-Enter": toggleTaskAtCaret,
            },
          });
          return { destroy: () => release?.() };
        },
        props: {
          transformCopied: (slice) => copiedSlice(slice),
          handleDOMEvents: {
            // The box is drawn in the block's indent, so a press there is on the block's own element.
            mousedown: (view, event) => {
              if (!view.editable || event.button !== 0) return false;
              const target = event.target as HTMLElement | null;
              const block = target?.closest?.<HTMLElement>(
                '[data-item="todo"], [data-item="done"]',
              );
              if (!block || !view.dom.contains(block) || !inMarkerGutter(block, event.clientX)) {
                return false;
              }
              const inside = view.posAtDOM(block, 0);
              const $inside = view.state.doc.resolve(inside);
              const tr = view.state.tr;
              if (!toggleTaskAt(tr, $inside.before($inside.depth))) return false;
              event.preventDefault();
              view.dispatch(tr);
              return true;
            },
          },
        },
      }),
    ];
  },
});
