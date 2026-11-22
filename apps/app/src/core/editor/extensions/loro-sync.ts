import { loroSyncPlugin } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import type { EditorCopy } from "../config";
import type { DocumentHistory } from "../editor-history";

export type LoroSyncOptions = { copy: EditorCopy | null; history: DocumentHistory | null };

/**
 * The binding (`@meridian/loro-prosemirror`) on the session's copy. Every write it makes leaves
 * by the session's `publish`, and the binding records it in the document's Undo (`history.steps`).
 */
export const LoroSyncExtension = Extension.create<LoroSyncOptions>({
  name: "loroSync",
  addOptions: () => ({ copy: null, history: null }),
  addProseMirrorPlugins() {
    const { copy, history } = this.options;
    if (!copy) return [];
    const { editor } = this;
    return [
      loroSyncPlugin({
        docs: copy.docs,
        history: history?.steps,
        onLocalWrite: (changes) => {
          copy.publish(changes);
          history?.changed(editor);
        },
      }),
    ];
  },
});
