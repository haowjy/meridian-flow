/**
 * The quiet mark on a paragraph someone deleted while the caret was in it, kept while the caret
 * stays (the binding's `kept`, design §1, "The caret rule"), so it doesn't read as the writer's or
 * as a failure: a tint, and a tooltip and accessible description that say why it is there.
 */
import { t } from "@lingui/core/macro";
import { loroSyncKey } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const keptKey = new PluginKey<DecorationSet>("kept");

function decorate(state: EditorState): DecorationSet {
  const removed = loroSyncKey.getState(state)?.kept;
  if (!removed?.size) return DecorationSet.empty;
  const label = t`Deleted while you were in it. It stays until you leave it.`;
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    const id = node.attrs.id;
    if (typeof id === "string" && removed.has(id))
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "meridian-kept",
          title: label,
          "aria-description": label,
        }),
      );
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
