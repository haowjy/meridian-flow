/**
 * A paragraph someone deleted while the caret was in it, kept while the caret stays (the
 * binding's `kept`, design §1, "The caret rule"), shows in muted ink and nothing else: no words,
 * and no mark once it goes.
 */
import { loroSyncKey } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

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
