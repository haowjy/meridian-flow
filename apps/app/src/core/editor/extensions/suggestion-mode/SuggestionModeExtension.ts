/**
 * Suggestion mode: a Work's draft is that Work's suggestion marks inside the Live document.
 * The editor always holds the whole document and shows one view of it (`@meridian/suggestions`):
 * hidden text is `display: none`, the caret never rests inside it, a copy leaves it out, and every
 * local edit passes through `rewrite` before it lands.
 */
import { documentMarks } from "@meridian/prosemirror-schema";
import {
  type Author,
  accept,
  blockKind,
  type Filter,
  kindOf,
  liveView,
  RAW_META,
  reject,
  removedIn,
  rewrite,
  type View,
  viewAttrs,
  visibleSlice,
} from "@meridian/suggestions";
import { Extension, Mark } from "@tiptap/core";
import type { MarkSpec, Node as PMNode } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import "./suggestion-mode.css";

/** The marks always exist (the schema is shared); only the behaviour is behind the flag. */
export const suggestionModeEnabled = import.meta.env.VITE_FLOW_SUGGESTIONS === "1";

type ModeState = { view: View; author: Author | null; decorations: DecorationSet };

const suggestionModeKey = new PluginKey<ModeState>("suggestionMode");

const unrendered = { default: null, rendered: false };

/**
 * A mark's attributes ride its element as JSON, so the editor's re-read of a DOM change keeps
 * them. Their order must be the shared schema's: the binding hashes a mark's JSON to key it.
 */
function annotationAttributes(mark: keyof typeof documentMarks) {
  return () =>
    Object.fromEntries(
      Object.keys((documentMarks[mark] as MarkSpec).attrs ?? {}).map((name) => [
        name,
        {
          ...unrendered,
          parseHTML: (element: HTMLElement) =>
            (JSON.parse(element.dataset.annotation ?? "{}") as Record<string, unknown>)[name] ??
            null,
        },
      ]),
    );
}

function annotationMark(name: keyof typeof documentMarks, className?: string) {
  const spec = documentMarks[name] as MarkSpec;
  return Mark.create({
    name,
    // As the shared schema has them: the binding keys a mark by `excludes`, then by its JSON.
    inclusive: spec.inclusive,
    excludes: spec.excludes,
    addAttributes: annotationAttributes(name),
    parseHTML: () => [{ tag: `span[data-${name}]` }],
    renderHTML: ({ mark }) => [
      "span",
      {
        [`data-${name}`]: "",
        "data-annotation": JSON.stringify(mark.attrs),
        ...(className ? { class: className } : {}),
      },
      0,
    ],
  });
}

const SuggestIns = annotationMark("suggest_ins");
const SuggestDel = annotationMark("suggest_del");
const CommentMark = annotationMark("comment", "meridian-comment");

const SUGGESTION_BLOCK_TYPES = [
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
    suggestionMode: {
      /** Show `view`; `author` writes this tab's suggestions (null in the Live view). */
      setSuggestionView: (view: View, author: Author | null) => ReturnType;
      acceptSuggestions: (filter: Filter) => ReturnType;
      rejectSuggestions: (filter: Filter) => ReturnType;
      /** A comment anchor over the selection: a bare mark with an id. */
      addComment: () => ReturnType;
    };
  }
}

/** The view the editor shows: what every reader of the editor's blocks reads them through. */
export function suggestionView(state: EditorState): View {
  return suggestionModeKey.getState(state)?.view ?? liveView;
}

/** The view each editor document is shown in, for a command that holds only its transaction. */
const viewOfDoc = new WeakMap<PMNode, View>();

/**
 * A block's attributes as the editor shows them: in a Work's view, Live's with the Work's pending
 * change applied. A command that sets a block's attributes reads them here, so it builds on what
 * the writer sees; `rewrite` turns what it sets into the pending change. The stored suggestion
 * attributes are kept, so a command that copies the attributes writes them back unchanged.
 */
export function shownAttrs(tr: Transaction, node: PMNode): Record<string, unknown> {
  if (!("sug" in node.attrs)) return node.attrs;
  const view = viewOfDoc.get(tr.before) ?? liveView;
  return { ...viewAttrs(node, view), sug: node.attrs.sug, sugAttrs: node.attrs.sugAttrs };
}

/**
 * The view the editor shows after `tr`, read from the state before it: a plugin's state may be
 * computed before this one's.
 */
export function suggestionViewAfter(tr: Transaction, before: EditorState): View | null {
  const set = tr.getMeta(suggestionModeKey) as { view: View } | undefined;
  if (set) return set.view;
  return tr.docChanged ? suggestionView(before) : null;
}

export const SuggestionModeExtension = Extension.create({
  name: "suggestionMode",

  addExtensions() {
    return [SuggestIns, SuggestDel, CommentMark];
  },

  addGlobalAttributes() {
    return [
      {
        types: SUGGESTION_BLOCK_TYPES,
        attributes: {
          sug: { ...unrendered, keepOnSplit: false },
          sugAttrs: { ...unrendered, keepOnSplit: false },
        },
      },
    ];
  },

  addCommands() {
    return {
      setSuggestionView:
        (view, author) =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(suggestionModeKey, { view, author }).setMeta(RAW_META, true));
          return true;
        },
      acceptSuggestions:
        (filter) =>
        ({ state, dispatch }) => {
          dispatch?.(accept(state, filter));
          return true;
        },
      rejectSuggestions:
        (filter) =>
        ({ state, dispatch }) => {
          dispatch?.(reject(state, filter));
          return true;
        },
      addComment:
        () =>
        ({ state, tr, dispatch }) => {
          if (state.selection.empty) return false;
          const mark = state.schema.marks.comment.create({ id: globalThis.crypto.randomUUID() });
          // Through `rewrite`, like any edit: the anchor lands only on text the view shows.
          dispatch?.(tr.addMark(state.selection.from, state.selection.to, mark));
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Alt-m": () => suggestionModeEnabled && this.editor.commands.addComment(),
    };
  },

  dispatchTransaction({ transaction, next }) {
    const state = this.editor.state;
    const mode = suggestionModeKey.getState(state);
    // A peer's change, Undo and Redo come through the binding already in stored form.
    if (!mode || transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) return next(transaction);
    next(rewrite(transaction, state, mode.view, mode.author));
  },

  addProseMirrorPlugins() {
    if (!suggestionModeEnabled) return [];
    return [
      new Plugin<ModeState>({
        key: suggestionModeKey,
        state: {
          init: (_, state) => ({
            view: liveView,
            author: null,
            decorations: paint(state.doc, liveView),
          }),
          apply(tr, value, _old, state) {
            const set = tr.getMeta(suggestionModeKey) as
              | Pick<ModeState, "view" | "author">
              | undefined;
            if (set) {
              viewOfDoc.set(state.doc, set.view);
              return { ...set, decorations: paint(state.doc, set.view) };
            }
            if (!tr.docChanged) return value;
            viewOfDoc.set(state.doc, value.view);
            return { ...value, decorations: paint(state.doc, value.view) };
          },
        },
        props: {
          decorations: (state) => suggestionModeKey.getState(state)?.decorations,
          transformCopied: (slice, view) =>
            visibleSlice(slice, view.state.selection.$from.parent, suggestionView(view.state)),
        },
        // The caret never rests inside hidden text: it goes to the edge it was moving toward.
        appendTransaction(trs, oldState, newState) {
          if (!trs.some((tr) => tr.selectionSet || tr.docChanged)) return null;
          const { selection } = newState;
          if (!selection.empty) return null;
          const target = outOfHidden(
            newState,
            selection.head,
            selection.head >= oldState.selection.head ? 1 : -1,
          );
          return target === null
            ? null
            : newState.tr
                .setSelection(TextSelection.create(newState.doc, target))
                .setMeta(RAW_META, true);
        },
      }),
    ];
  },
});

function paint(doc: PMNode, view: View): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (block.isInline) return false;
    const end = blockPos + block.nodeSize;
    const owner = "sug" in block.attrs ? blockKind(block, view) : "live";
    if (owner !== "live") {
      decorations.push(
        Decoration.node(blockPos, end, {
          class: owner === "hidden" ? "sug-hidden" : "sug-ins-block",
        }),
      );
      return false;
    }
    if (removedIn(block, view))
      decorations.push(Decoration.node(blockPos, end, { class: "sug-del-block" }));
    // A pending change to the block's attributes shows them; the element is still Live's.
    const shown = viewAttrs(block, view);
    if (block.attrs.sugAttrs && !sameAttrs(shown, { ...block.attrs, sug: null, sugAttrs: null }))
      decorations.push(
        Decoration.node(blockPos, end, {
          class: "sug-attrs",
          "data-view-level": String(shown.level ?? 0),
        }),
      );
    if (!block.isTextblock) return true;
    block.forEach((child, offset) => {
      const kind = kindOf(child.marks, block, view);
      if (kind === "live") return;
      const from = blockPos + 1 + offset;
      decorations.push(
        Decoration.inline(from, from + child.nodeSize, {
          class: kind === "hidden" ? "sug-hidden" : kind === "own-ins" ? "sug-ins" : "sug-del",
        }),
      );
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function hiddenAt(state: EditorState, pos: number, side: -1 | 1): boolean {
  const $pos = state.doc.resolve(pos);
  const view = suggestionView(state);
  for (let depth = $pos.depth; depth >= 1; depth--) {
    const node = $pos.node(depth);
    if ("sug" in node.attrs && blockKind(node, view) === "hidden") return true;
  }
  const node = side < 0 ? $pos.nodeBefore : $pos.nodeAfter;
  return !!node && node.isInline && kindOf(node.marks, $pos.parent, view) === "hidden";
}

function outOfHidden(state: EditorState, pos: number, direction: -1 | 1): number | null {
  const inside = (at: number) => hiddenAt(state, at, -1) && hiddenAt(state, at, 1);
  if (!inside(pos)) return null;
  let at = pos;
  const size = state.doc.content.size;
  while (at > 0 && at < size && inside(at)) at += direction;
  if (inside(at)) {
    at = pos;
    while (at > 0 && at < size && inside(at)) at -= direction;
  }
  return TextSelection.near(state.doc.resolve(at), direction).head;
}

function sameAttrs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
