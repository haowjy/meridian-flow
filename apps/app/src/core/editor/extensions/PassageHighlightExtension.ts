/**
 * The landing a search-match door promises: a transient mark on the words that
 * matched, and a scroll only when the writer cannot already see them.
 *
 * **Never a selection.** A selection would move the writer's cursor, and the
 * writer may be mid-sentence somewhere else. This marks; it does not take.
 *
 * The mark is short-lived by contract. It fades on its own, and it clears the
 * moment the writer does anything — types, moves the caret, or undoes — because
 * from then on the document is their business again. A peer's edit is not the
 * writer moving: those arrive constantly and would otherwise wipe the mark
 * before it was read.
 *
 * Telling the two apart needs care. Collaborative undo is the writer's own
 * keystroke, but it reaches ProseMirror through the same ySync channel a peer's
 * edit does, so the metadata has to be read rather than merely noticed.
 */
import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type { TextRange } from "../passage-resolution";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    passageHighlight: {
      showPassageMatches: (ranges: readonly TextRange[]) => ReturnType;
      clearPassageMatches: () => ReturnType;
    };
  }
}

const passageKey = new PluginKey<DecorationSet>("passage-highlight");
const PASSAGE_META = "passage-highlight";
/** Matches the CSS fade, so the mark is removed once it has finished going. */
const HIGHLIGHT_DURATION_MS = 3_400;
/** Below this the passage counts as visible and the writer keeps their scroll. */
const EDGE_MARGIN_PX = 24;

const clearTimers = new WeakMap<Editor, ReturnType<typeof setTimeout>>();

export const PASSAGE_MATCH_ATTRIBUTE = "data-passage-match";

export const PassageHighlightExtension = Extension.create({
  name: "passageHighlight",
  addCommands() {
    return {
      showPassageMatches:
        (ranges) =>
        ({ editor, tr, dispatch }) => {
          if (ranges.length === 0) return false;
          dispatch?.(tr.setMeta(PASSAGE_META, [...ranges]));
          revealIfNeeded(editor);
          scheduleClear(editor);
          return true;
        },
      clearPassageMatches:
        () =>
        ({ tr, dispatch }) => {
          dispatch?.(tr.setMeta(PASSAGE_META, null));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: passageKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, prior) {
            const meta = tr.getMeta(PASSAGE_META) as TextRange[] | null | undefined;
            if (meta !== undefined) {
              return meta
                ? DecorationSet.create(
                    tr.doc,
                    meta.map((range) =>
                      Decoration.inline(range.from, range.to, {
                        [PASSAGE_MATCH_ATTRIBUTE]: "true",
                        class: "passage-match-highlight",
                      }),
                    ),
                  )
                : DecorationSet.empty;
            }
            if (prior === DecorationSet.empty) return prior;
            if (writerMoved(tr)) return DecorationSet.empty;
            return prior.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => passageKey.getState(state) ?? DecorationSet.empty },
      }),
    ];
  },
});

/**
 * Whether this transaction is the writer taking the document back.
 *
 * `@tiptap/y-tiptap` signs every change it applies with the same plugin key and
 * distinguishes them in the payload: an undo carries `isUndoRedoOperation`
 * because its Yjs origin is the local `UndoManager`, which only the writer's
 * own Ctrl+Z reaches. A peer's edit carries the key without it.
 */
function writerMoved(tr: Transaction): boolean {
  if (!tr.docChanged && !tr.selectionSet) return false;
  const ySync = tr.getMeta(ySyncPluginKey) as { isUndoRedoOperation?: boolean } | undefined;
  return ySync === undefined || ySync.isUndoRedoOperation === true;
}

/**
 * Center the passage only when it is off-screen or crowding an edge. A writer
 * who can already see the sentence did not ask to have their page moved.
 */
function revealIfNeeded(editor: Editor): void {
  requestAnimationFrame(() => {
    if (editor.isDestroyed) return;
    const target = editor.view.dom.querySelector<HTMLElement>(`[${PASSAGE_MATCH_ATTRIBUTE}]`);
    if (!target) return;
    const viewport = scrollViewportRect(target);
    const rect = target.getBoundingClientRect();
    const visible =
      rect.top >= viewport.top + EDGE_MARGIN_PX && rect.bottom <= viewport.bottom - EDGE_MARGIN_PX;
    if (visible) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  });
}

/** The nearest scrolling ancestor's viewport, falling back to the window's. */
function scrollViewportRect(element: HTMLElement): { top: number; bottom: number } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (node.scrollHeight <= node.clientHeight) continue;
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }
  return { top: 0, bottom: window.innerHeight };
}

function scheduleClear(editor: Editor): void {
  const prior = clearTimers.get(editor);
  if (prior) clearTimeout(prior);
  clearTimers.set(
    editor,
    setTimeout(() => {
      clearTimers.delete(editor);
      if (!editor.isDestroyed) editor.commands.clearPassageMatches();
    }, HIGHLIGHT_DURATION_MS),
  );
}
