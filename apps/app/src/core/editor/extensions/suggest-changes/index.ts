/**
 * Suggestions inside the live document: the marks, and the view an editor shows. Live hides
 * every insertion and reads every deletion as plain text; a Work's view paints the Work's
 * suggestions, and typing there becomes them. One rule, `rewrite`, decides both.
 */
import { documentMarks, documentNodes } from "@meridian/prosemirror-schema";
import { rewrite, type Suggester } from "@meridian/suggestions";
import { type Editor, Extension, Mark } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** What an editor shows: Live, or a Work's view with typing as `suggester`'s suggestions. */
export type SuggestionView = { suggester: Suggester | null };

const viewKey = new PluginKey<SuggestionView>("suggestion-view");

const TAGS = {
  insertion: "ins",
  deletion: "del",
  modification: "span",
  blockBoundarySuggestion: "span",
};

/** The shared specs as TipTap marks. No parse rule: pasted `<ins>` and `<del>` arrive as plain text. */
export const SuggestionMarks = (Object.keys(TAGS) as (keyof typeof TAGS)[]).map((name) => {
  const { attrs, ...spec } = documentMarks[name];
  return Mark.create({
    name,
    inclusive: spec.inclusive,
    ...("excludes" in spec ? { excludes: spec.excludes } : {}),
    addAttributes: () => attrs,
    renderHTML: ({ HTMLAttributes }) => [
      TAGS[name],
      {
        "data-suggestion": name,
        "data-suggestion-id": String(HTMLAttributes.id),
        "data-suggestion-turn": HTMLAttributes.turn ?? "",
      },
      0,
    ],
  });
});

/** The blocks that store their own suggestions, and the nodes whose children may hold them. */
const SUGGESTING_BLOCKS = Object.entries(documentNodes)
  .filter(([, spec]) => "attrs" in spec && "suggestion" in spec.attrs)
  .map(([name]) => name);
const markHolders = documentNodes as Record<string, { marks?: string }>;

type StoredSuggestion = { type: string; attrs: { type?: string | null } };

/** Every local transaction goes through `rewrite` for the view the editor shows. */
export const SuggestionViewExtension = Extension.create({
  name: "suggestionView",
  extendNodeSchema: (extension) => {
    const marks = markHolders[extension.name]?.marks;
    return marks ? { marks } : {};
  },
  addGlobalAttributes: () => [
    {
      types: SUGGESTING_BLOCKS,
      attributes: {
        suggestion: {
          default: null,
          keepOnSplit: false,
          parseHTML: () => null,
          renderHTML: (attributes: Record<string, unknown>) => {
            const stored = attributes.suggestion as StoredSuggestion[] | null;
            if (!stored?.length) return {};
            return {
              "data-block-suggestion": stored
                .map((mark) =>
                  mark.type === "blockBoundarySuggestion"
                    ? `boundary-${mark.attrs.type}`
                    : mark.type,
                )
                .join(" "),
            };
          },
        },
      },
    },
  ],
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
