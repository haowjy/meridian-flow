import { t } from "@lingui/core/macro";
import { loroSyncKey } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { announce } from "@/client/stores/thread-store/announcements";

function decorate(doc: Node, kept: ReadonlySet<string>): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const id = node.attrs.id;
    if (typeof id === "string" && kept.has(id))
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "meridian-kept" }));
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
}

export const KeptExtension = Extension.create({
  name: "kept",
  addProseMirrorPlugins() {
    let last: { doc: Node; kept: ReadonlySet<string>; set: DecorationSet } | null = null;
    return [
      new Plugin({
        view: () => ({
          update(view, previous) {
            const was = loroSyncKey.getState(previous)?.kept.size ?? 0;
            const now = loroSyncKey.getState(view.state)?.kept.size ?? 0;
            if (was === 0 && now > 0 && view.hasFocus()) announce(t`Paragraph removed elsewhere`);
          },
        }),
        props: {
          // Read at render, not in a plugin state's `apply`: there the binding's state for the
          // same transaction may not be built yet (plugin order), so the mark lagged a step.
          decorations(state: EditorState) {
            const kept = loroSyncKey.getState(state)?.kept;
            if (!kept?.size) return null;
            if (last?.doc !== state.doc || last.kept !== kept)
              last = { doc: state.doc, kept, set: decorate(state.doc, kept) };
            return last.set;
          },
        },
      }),
    ];
  },
});
