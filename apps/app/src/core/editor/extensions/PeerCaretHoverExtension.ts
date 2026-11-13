import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { getEditorChrome, hoverOwner } from "../chrome";

const CARET = "meridian-collab-cursor";
/** How far either side of a peer's caret line still names the peer, in px. */
const REACH = 4;

/**
 * Names a peer's caret while the pointer is on or beside its line. The caret's DOM stays
 * transparent to the pointer, so a press beside it still places the writer's caret and starts a
 * drag-select; the hover is read from the kernel's one pointer source against the caret's box.
 */
export const PeerCaretHoverExtension = Extension.create({
  name: "peerCaretHover",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("peerCaretHover"),
        view(view) {
          let shown: HTMLElement | null = null;
          const release = getEditorChrome(editor)?.registerHoverAnchor<HTMLElement>({
            id: "peer-caret",
            probe: ({ x, y }) => {
              for (const caret of view.dom.getElementsByClassName(CARET)) {
                const box = caret.getBoundingClientRect();
                if (x < box.left - REACH || x > box.right + REACH) continue;
                if (y < box.top - REACH || y > box.bottom) continue;
                const owner = hoverOwner(view, caret);
                return owner ? { owner, value: caret as HTMLElement } : null;
              }
              return null;
            },
            onSettle: (caret) => {
              if (shown === caret) return;
              shown?.removeAttribute("data-hovered");
              caret?.setAttribute("data-hovered", "");
              shown = caret;
            },
          });
          return { destroy: () => release?.() };
        },
      }),
    ];
  },
});
