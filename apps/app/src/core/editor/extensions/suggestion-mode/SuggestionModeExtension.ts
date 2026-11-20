/**
 * Suggestion mode: a Work's draft is that Work's suggestion marks inside the Live document.
 * The editor always holds the whole document and shows one view of it (`@meridian/suggestions`):
 * hidden text is `display: none`, the caret never rests inside it, a copy leaves it out, and every
 * local edit passes through `rewrite` before it lands. Apply and Reject run on the editor's Y.Doc
 * through the server's own resolve.
 */
import { resolveStored, suggestionAuthors } from "@meridian/agent-edit";
import { documentMarks } from "@meridian/prosemirror-schema";
import {
  type Author,
  type Authors,
  blockKind,
  DROPPED_META,
  type Filter,
  kindOf,
  liveView,
  proposals,
  RAW_META,
  removedIn,
  rewrite,
  sameValue,
  type View,
  viewAttrs,
  visible,
  visibleSlice,
} from "@meridian/suggestions";
import { Extension, Mark } from "@tiptap/core";
import type { MarkSpec, Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { endUndoStep } from "../../editor-history";
import { createBarSlotElement } from "../inline-review/removal-widget";
import "./suggestion-mode.css";

/** The marks always exist (the schema is shared); only the behaviour is behind the flag. */
export const suggestionModeEnabled = import.meta.env.VITE_FLOW_SUGGESTIONS === "1";

/**
 * What the editor shows: a view, who writes this tab's suggestions in it, and its review's paint:
 * the change in focus, and whether changes are marked at all (off: the view reads as if applied).
 */
type ModeState = {
  view: View;
  author: Author | null;
  focus: string | null;
  marks: boolean;
  /** The block the focused change's bar opens after, when the margin has no room for it. */
  slot: boolean;
  decorations: DecorationSet;
};
type Review = Pick<ModeState, "focus" | "marks" | "slot">;

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
      /** The review's paint: the change in focus, and whether changes are marked. */
      setSuggestionReview: (review: Partial<Review>) => ReturnType;
      /** The review's focus commands, as the draft review's editor has them (`DraftReviewController`). */
      setReviewActiveChange: (changeId: string | null) => ReturnType;
      scrollReviewChangeIntoView: (changeId: string, options?: { instant?: boolean }) => ReturnType;
      setReviewBarSlot: (open: boolean) => ReturnType;
      acceptSuggestions: (filter: Filter) => ReturnType;
      rejectSuggestions: (filter: Filter) => ReturnType;
      /** A comment anchor over the selection: a bare mark with an id. */
      addComment: () => ReturnType;
    };
  }
}

/** The change a review's mark at a DOM element belongs to: its bar and focus find it by this. */
export const SUGGESTION_CHANGE_ATTR = "data-review-change";

/** The view the editor shows: what every reader of the editor's blocks reads them through. */
export function suggestionView(state: EditorState): View {
  return suggestionModeKey.getState(state)?.view ?? liveView;
}

/** The review's change in focus, as the editor paints it. */
export function suggestionFocus(state: EditorState): string | null {
  return suggestionModeKey.getState(state)?.focus ?? null;
}

/**
 * The text the editor's view reads between `from` and `to` (inside one textblock), and where an
 * offset in that text lies in the document: the bridge for a command that shows a range's words
 * and edits them back. At an offset between two shown runs with unshown text between them,
 * `side` -1 is the end of the earlier run, 1 the start of the later.
 */
export function shownText(
  state: EditorState,
  from: number,
  to: number,
): { text: string; at(offset: number, side: -1 | 1): number } {
  const view = suggestionView(state);
  const runs: Array<{ offset: number; pos: number; length: number }> = [];
  let text = "";
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || !parent || !visible(kindOf(node.marks, parent, view))) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    runs.push({ offset: text.length, pos: start, length: end - start });
    text += (node.text ?? "").slice(start - pos, end - pos);
  });
  const at = (offset: number, side: -1 | 1) => {
    const run =
      (side < 0
        ? runs.find((r) => offset > r.offset && offset <= r.offset + r.length)
        : runs.find((r) => offset >= r.offset && offset < r.offset + r.length)) ??
      (side < 0 ? runs[0] : runs.at(-1));
    return run ? run.pos + Math.max(0, Math.min(run.length, offset - run.offset)) : from;
  };
  return { text, at };
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
      setSuggestionReview:
        (review) =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(suggestionModeKey, review).setMeta(RAW_META, true));
          return true;
        },
      setReviewActiveChange:
        (focus) =>
        ({ commands }) =>
          commands.setSuggestionReview({ focus }),
      setReviewBarSlot:
        (slot) =>
        ({ commands }) =>
          commands.setSuggestionReview({ slot }),
      scrollReviewChangeIntoView:
        (changeId, options) =>
        ({ view }) => {
          const target = view.dom.querySelector(
            `[${SUGGESTION_CHANGE_ATTR}="${CSS.escape(changeId)}"]`,
          );
          if (!target) return false;
          const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          target.scrollIntoView({
            block: "center",
            behavior: reduceMotion || options?.instant ? "auto" : "smooth",
          });
          return true;
        },
      acceptSuggestions:
        (filter) =>
        ({ state, tr, dispatch }) =>
          resolveHere(state, tr, "accept", filter, !!dispatch),
      rejectSuggestions:
        (filter) =>
        ({ state, tr, dispatch }) =>
          resolveHere(state, tr, "reject", filter, !!dispatch),
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
    const out = rewrite(transaction, state, mode.view, mode.author, authorsIn(state));
    // An edit the view cannot suggest in full does not happen at all, as for the model.
    if (!out.getMeta(DROPPED_META)) next(out);
  },

  addProseMirrorPlugins() {
    if (!suggestionModeEnabled) return [];
    return [
      new Plugin<ModeState>({
        key: suggestionModeKey,
        state: {
          init: (_, state) => {
            const init = { view: liveView, author: null, focus: null, marks: true, slot: false };
            return { ...init, decorations: paint(state.doc, init) };
          },
          apply(tr, value, _old, state) {
            const set = tr.getMeta(suggestionModeKey) as Partial<ModeState> | undefined;
            if (!set && !tr.docChanged) return value;
            const next = { ...value, ...set };
            viewOfDoc.set(state.doc, next.view);
            return { ...next, decorations: paint(state.doc, next) };
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

function editorDoc(state: EditorState): Y.Doc | null {
  return (ySyncPluginKey.getState(state)?.doc as Y.Doc | undefined) ?? null;
}

/** Who wrote each change in the editor's document; an editor with no Y.Doc keeps none. */
export function authorsIn(state: EditorState): Authors {
  const doc = editorDoc(state);
  return doc ? suggestionAuthors(doc) : new Map();
}

/**
 * Apply or Reject in the tab: the server's resolve, run on this tab's Y.Doc as one writer edit of
 * its own, so it syncs as typing does and Ctrl+Z takes back only it. The binding then redraws the
 * editor from the Y.Doc, so the command's own transaction is not dispatched.
 */
function resolveHere(
  state: EditorState,
  tr: Transaction,
  verdict: "accept" | "reject",
  filter: Filter,
  run: boolean,
): boolean {
  const doc = editorDoc(state);
  if (!doc) return false;
  if (!run) return true;
  tr.setMeta("preventDispatch", true);
  endUndoStep(state);
  doc.transact((transaction) => {
    // What the binding sets on a writer's edit: history and unsent typing count it as one.
    transaction.meta.set("addToHistory", true);
    resolveStored(doc, state.schema, verdict, filter);
  }, ySyncPluginKey);
  endUndoStep(state);
  return true;
}

/**
 * The view's decorations. Text another Work added is hidden. With marks on, the view's own
 * insertions are green and its deletions struck red, as the draft review's marks; the focused
 * change is emphasized. With marks off, the view reads as if applied: its deletions are hidden too.
 */
function paint(doc: PMNode, state: Omit<ModeState, "decorations" | "author">): DecorationSet {
  const { view, focus, marks, slot } = state;
  const decorations: Decoration[] = [];
  /** Where the focused change ends, for its bar's slot. */
  let focusEnd = -1;
  const decorate = (
    from: number,
    to: number,
    attrs: Record<string, string>,
    node?: "node",
  ): void => {
    if (focus && attrs[SUGGESTION_CHANGE_ATTR] === focus) focusEnd = Math.max(focusEnd, to);
    decorations.push(node ? Decoration.node(from, to, attrs) : Decoration.inline(from, to, attrs));
  };
  const added = (id: string | undefined, block = false) => ({
    class: [
      "meridian-review-added",
      block && "meridian-review-block",
      id === focus && "meridian-review-emphasized",
    ]
      .filter(Boolean)
      .join(" "),
    ...(id ? { [SUGGESTION_CHANGE_ATTR]: id } : {}),
  });
  const removed = (id: string | undefined, className: string) =>
    marks
      ? {
          class: [className, id === focus && "sug-focused"].filter(Boolean).join(" "),
          ...(id ? { [SUGGESTION_CHANGE_ATTR]: id } : {}),
        }
      : { class: "sug-hidden" };
  doc.descendants((block, blockPos) => {
    if (block.isInline) return false;
    const end = blockPos + block.nodeSize;
    const owner = "sug" in block.attrs ? blockKind(block, view) : "live";
    if (owner === "hidden") {
      decorate(blockPos, end, { class: "sug-hidden" }, "node");
      return false;
    }
    if (owner === "own" && marks)
      decorate(blockPos, end, added(block.attrs.sug?.id, true), "node");
    const own = view.work ? (proposals(block)[view.work] ?? []) : [];
    if (removedIn(block, view))
      decorate(blockPos, end, removed(own.find((layer) => layer.remove)?.id, "sug-del-block"), "node");
    // A pending change to the block's attributes shows them; the element is still Live's.
    const shown = viewAttrs(block, view);
    if (
      owner === "live" &&
      block.attrs.sugAttrs &&
      !sameValue(shown, { ...block.attrs, sug: null, sugAttrs: null })
    )
      decorate(
        blockPos,
        end,
        {
          ...(marks ? { class: "sug-attrs" } : {}),
          ...(marks && own[0] ? { [SUGGESTION_CHANGE_ATTR]: own[own.length - 1]?.id } : {}),
          "data-view-level": String(shown.level ?? 0),
        },
        "node",
      );
    if (!block.isTextblock) return true;
    block.forEach((child, offset) => {
      const kind = kindOf(child.marks, block, view);
      // The Work's own block shows its text as added already; a later turn's deletion is struck.
      if (kind === "live" || (owner === "own" && kind === "own-ins")) return;
      const from = blockPos + 1 + offset;
      const id = ownChange(child.marks, view, kind === "own-ins" ? "suggest_ins" : "suggest_del");
      const attrs =
        kind === "hidden"
          ? { class: "sug-hidden" }
          : kind === "own-ins"
            ? marks
              ? added(id)
              : null
            : removed(id, "sug-del");
      if (attrs) decorate(from, from + child.nodeSize, attrs);
    });
    return false;
  });
  if (slot && focusEnd >= 0) {
    // After the block the change ends in; one keyed widget, so it keeps its DOM as focus moves.
    const $end = doc.resolve(focusEnd);
    const at = $end.depth > 0 ? $end.after(1) : focusEnd;
    decorations.push(
      Decoration.widget(at, (editorView) => createBarSlotElement(editorView.dom.ownerDocument), {
        key: "bar-slot",
        side: 1,
        stopEvent: () => true,
        ignoreSelection: true,
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

/** The view's own change a run's mark of `name` belongs to: the one its review lists it under. */
function ownChange(marks: readonly PMMark[], view: View, name: string): string | undefined {
  return marks.find((mark) => mark.type.name === name && mark.attrs.work === view.work)?.attrs.id;
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
