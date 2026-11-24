/**
 * A paragraph someone deleted while the caret was in it, kept while the caret stays (the
 * binding's `kept`, design §1, "The caret rule"), shows in muted ink and nothing else: no words,
 * and no mark once it goes.
 */
import { loroSyncKey } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const keptKey = new PluginKey<DecorationSet>("kept");

function decorate(state: EditorState): DecorationSet {
  const removed = loroSyncKey.getState(state)?.kept;
  if (!removed?.size) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    const id = node.attrs.id;
    if (typeof id === "string" && removed.has(id))
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "meridian-kept" }));
    return !node.isTextblock;
  });
  return DecorationSet.create(state.doc, decorations);
}

export const KeptExtension = Extension.create({
  name: "kept",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: keptKey,
        state: {
          init: (_config, state) => decorate(state),
          apply(tr, prior, old, next) {
            const removed = loroSyncKey.getState(next)?.kept;
            if (removed === loroSyncKey.getState(old)?.kept && !tr.docChanged) return prior;
            return decorate(next);
          },
        },
        props: { decorations: (state) => keptKey.getState(state) },
      }),
    ];
  },
});
