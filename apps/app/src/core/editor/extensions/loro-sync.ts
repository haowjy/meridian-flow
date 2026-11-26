import { loroSyncPlugin } from "@meridian/loro-prosemirror";
import { newBlockId } from "@meridian/prosemirror-schema";
import { Extension } from "@tiptap/core";
import type { EditorCopy } from "../config";
import type { DocumentHistory } from "../editor-history";

export type LoroSyncOptions = { copy: EditorCopy | null; history: DocumentHistory | null };

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
        newBlockId,
        onLocalWrite: (changes) => {
          copy.publish(changes);
          history?.changed(editor);
        },
      }),
    ];
  },
});
