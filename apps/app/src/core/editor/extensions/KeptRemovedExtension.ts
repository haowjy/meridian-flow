/**
 * A paragraph another device deleted, kept on screen while the caret is in it (design §1, "The
 * caret rule"), reads as kept, not as the writer's own: a quiet tint, and a tooltip and accessible
 * description that say what it is, so its going when the caret leaves does not read as the click
 * deleting it.
 */
import { t } from "@lingui/core/macro";
import { loroSyncKey } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const keptKey = new PluginKey<DecorationSet>("kept-removed");

export const KeptRemovedExtension = Extension.create({
  name: "keptRemoved",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: keptKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, prior, old, next) {
            const kept = loroSyncKey.getState(next)?.kept;
            if (kept === loroSyncKey.getState(old)?.kept && !tr.docChanged) return prior;
            if (!kept?.size) return DecorationSet.empty;
            const label = t`Deleted on another device. It stays while you're in it.`;
            const decorations: Decoration[] = [];
            next.doc.descendants((node, pos) => {
              if (typeof node.attrs.id === "string" && kept.has(node.attrs.id))
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: "meridian-kept-removed",
                    title: label,
                    "aria-description": label,
                  }),
                );
              return !node.isTextblock;
            });
            return DecorationSet.create(next.doc, decorations);
          },
        },
        props: { decorations: (state) => keptKey.getState(state) },
      }),
    ];
  },
});
