/**
 * Suggestions inside the live document: the marks, and the view an editor shows. Live hides
 * every insertion and reads every deletion as plain text; a Work's view paints the Work's
 * suggestions, and typing there becomes them. One rule, `rewrite`, decides both.
 */
import { rewrite, type Suggester } from "@meridian/suggestions";
import { type Editor, Extension, Mark } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** What an editor shows: Live, or a Work's view with typing as `suggester`'s suggestions. */
export type SuggestionView = { suggester: Suggester | null };

const viewKey = new PluginKey<SuggestionView>("suggestion-view");

const suggester = {
  work: { default: null },
  chat: { default: null },
  turn: { default: null },
  by: { default: null },
};

/** No parse rule: pasted `<ins>` and `<del>` arrive as plain text, never as a suggestion. */
function suggestionMark(name: string, tag: "ins" | "del" | "span", excludes?: string) {
  return Mark.create({
    name,
    inclusive: false,
    ...(excludes === undefined ? {} : { excludes }),
    addAttributes: () => ({ id: {}, ...suggester }),
    renderHTML: ({ HTMLAttributes }) => [
      tag,
      {
        "data-suggestion": name,
        "data-suggestion-id": String(HTMLAttributes.id),
        "data-suggestion-turn": HTMLAttributes.turn ?? "",
      },
      0,
    ],
  });
}

export const SuggestionMarks = [
  suggestionMark("insertion", "ins", "deletion modification insertion"),
  suggestionMark("deletion", "del", "insertion modification deletion"),
  suggestionMark("modification", "span", "deletion insertion").extend({
    addAttributes: () => ({
      id: {},
      type: {},
      attrName: { default: null },
      previousValue: { default: null },
      newValue: { default: null },
      ...suggester,
    }),
  }),
  suggestionMark("blockBoundarySuggestion", "span").extend({
    addAttributes: () => ({ id: { default: null }, type: { default: null }, ...suggester }),
  }),
];

/** Every local transaction goes through `rewrite` for the view the editor shows. */
export const SuggestionViewExtension = Extension.create({
  name: "suggestionView",
  // The library marks a whole inserted or deleted block on the block node.
  extendNodeSchema: (extension) =>
    extension.name === "doc"
      ? { marks: "insertion deletion modification blockBoundarySuggestion" }
      : {},
  dispatchTransaction({ transaction, next }) {
    const state = this.editor.state;
    next(rewrite(transaction, state, viewKey.getState(state)?.suggester ?? null));
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<SuggestionView>({
        key: viewKey,
        state: {
          init: () => ({ suggester: null }),
          apply: (tr, value) => (tr.getMeta(viewKey) as SuggestionView | undefined) ?? value,
        },
        props: {
          attributes: (state): Record<string, string> => ({
            "data-suggestion-view": viewKey.getState(state)?.suggester ? "work" : "live",
          }),
        },
      }),
    ];
  },
});

export function suggestionViewOf(editor: Editor): SuggestionView {
  return viewKey.getState(editor.state) ?? { suggester: null };
}

export function showSuggestionView(editor: Editor, view: SuggestionView): void {
  editor.view.dispatch(editor.state.tr.setMeta(viewKey, view).setMeta("addToHistory", false));
}
