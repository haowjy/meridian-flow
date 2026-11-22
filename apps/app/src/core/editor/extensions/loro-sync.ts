import { loroSyncPlugin } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import type { EditorCopy } from "../config";
import type { DocumentHistory } from "../editor-history";

export type LoroSyncOptions = { copy: EditorCopy | null; history: DocumentHistory | null };

/**
 * The binding (`@meridian/loro-prosemirror`) on the session's copy. Every write it makes leaves
 * by the session's `publish` and is recorded in the document's Undo, with the state the
 * transaction started from (its selection is what Undo puts back).
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
        onLocalWrite: (changes, tr) => {
          copy.publish(changes);
          history?.record(changes, tr, editor.view.state, editor);
        },
      }),
    ];
  },
});
