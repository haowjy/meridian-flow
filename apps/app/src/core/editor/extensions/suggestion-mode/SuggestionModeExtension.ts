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
  RAW_META,
  recordStarted,
  rewrite,
  STARTED_META,
  type View,
  viewAttrs,
  visible,
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
import type { DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { DIRECT_WRITE_ORIGIN, endUndoStep } from "../../editor-history";
import { type Paint, paintAll, repaint, SUGGESTION_CHANGE_ATTR } from "./suggestion-paint";
import "./suggestion-mode.css";

/** The marks always exist (the schema is shared); only the behaviour is behind the flag. */
export const suggestionModeEnabled = import.meta.env.VITE_FLOW_SUGGESTIONS === "1";

/**
 * What the editor shows (`Paint`), who writes this tab's suggestions in it, whether changes are
 * marked at all (off: the view reads as if applied), and its paint.
 */
type ModeState = Paint & { author: Author | null; marks: boolean; decorations: DecorationSet };
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
    const authors = authorsIn(state);
    const out = rewrite(transaction, state, mode.view, mode.author, authors);
    // An edit the view cannot suggest in full does not happen at all, as for the model.
    if (out.getMeta(DROPPED_META)) return;
    next(out);
    // A writer edit of its own, so unsent-edits counts it; the binding sends the text separately.
    if (out.getMeta(STARTED_META))
      editorDoc(state)?.transact(() => recordStarted(out, authors), DIRECT_WRITE_ORIGIN);
  },

  addProseMirrorPlugins() {
    if (!suggestionModeEnabled) return [];
    return [
      new Plugin<ModeState>({
        key: suggestionModeKey,
        state: {
          init: (_, state) => {
            const init = { view: liveView, author: null, focus: null, marks: true, slot: false };
            return { ...init, decorations: paintAll(state.doc, init) };
          },
          apply(tr, value, old, state) {
            const set = tr.getMeta(suggestionModeKey) as Partial<ModeState> | undefined;
            if (!set && !tr.docChanged) return value;
            const next = { ...value, ...set };
            viewOfDoc.set(state.doc, next.view);
            if (next.view.work !== value.view.work)
              return { ...next, decorations: paintAll(state.doc, next) };
            return {
              ...next,
              decorations: repaint(value.decorations, old.doc, state.doc, value, next),
            };
          },
        },
        props: {
          decorations: (state) => suggestionModeKey.getState(state)?.decorations,
          attributes: (state): Record<string, string> => ({
            "data-suggestion-marks":
              suggestionModeKey.getState(state)?.marks === false ? "off" : "on",
          }),
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
 * editor from the Y.Doc, so the command's own transaction is not dispatched: in a `chain()`, the
 * other commands' steps on that transaction are dropped with it. Run it on its own.
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
  doc.transact(() => resolveStored(doc, state.schema, verdict, filter), DIRECT_WRITE_ORIGIN);
  endUndoStep(state);
  return true;
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
