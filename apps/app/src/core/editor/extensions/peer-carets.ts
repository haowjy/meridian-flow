import { t } from "@lingui/core/macro";
import { Extension } from "@tiptap/core";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { type Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { yCursorPluginKey } from "@tiptap/y-tiptap";
import { getEditorChrome, hoverOwner } from "../chrome";
import type { PeerAwareness } from "../local-presence";

/** How far either side of a peer's caret line still names the peer, in px. */
const REACH = 4;

type PeerUser = { accountId?: string; name?: string; color?: string };

/** A peer's caret: the widget y-prosemirror places at its head. Its spec carries `side`. */
function isCaret(decoration: Decoration): boolean {
  return "side" in decoration.spec;
}

const selectionsOnly = new WeakMap<DecorationSet, DecorationSet>();

/**
 * Peers' selections, drawn by y-prosemirror as inline decorations, without its caret widgets. A
 * widget is a non-editable node in the line: a press just after it gives the browser a selection
 * anchor on one side of it and ProseMirror the other, so a drag starting there selects nothing.
 * The carets are drawn above the text by `PeerCaretLayer` instead.
 */
export const PeerSelections = CollaborationCaret.extend({
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).map((plugin) => {
      if (plugin.spec.key !== yCursorPluginKey) return plugin;
      return new Plugin({
        ...plugin.spec,
        props: {
          ...plugin.spec.props,
          decorations: (state) => {
            const all = yCursorPluginKey.getState(state) as DecorationSet | undefined;
            if (!all) return null;
            let kept = selectionsOnly.get(all);
            if (!kept) {
              kept = DecorationSet.create(
                state.doc,
                all.find().filter((decoration) => !isCaret(decoration)),
              );
              selectionsOnly.set(all, kept);
            }
            return kept;
          },
        },
      });
    });
  },
});

type PeerCaretLayerOptions = { peers: PeerAwareness | null; accountId: string };

/**
 * Peers' carets on a layer over the prose, positioned from the heads y-prosemirror tracks. The
 * layer scrolls with the page and takes no pointer; the name shows while the pointer is on or
 * beside a caret's line, read from the editor's one pointer source.
 */
export const PeerCaretLayer = Extension.create<PeerCaretLayerOptions>({
  name: "peerCaretLayer",

  addOptions() {
    return { peers: null, accountId: "" };
  },

  addProseMirrorPlugins() {
    const { editor } = this;
    const { peers, accountId } = this.options;
    return [
      new Plugin({
        key: new PluginKey("peerCaretLayer"),
        view(view) {
          const layer = document.createElement("div");
          layer.className = "meridian-peer-carets";
          layer.setAttribute("aria-hidden", "true");
          view.dom.after(layer);
          const carets = new Map<number, { element: HTMLElement; head: number }>();

          const draw = (current: EditorView) => {
            const decorations = yCursorPluginKey.getState(current.state) as
              | DecorationSet
              | undefined;
            // The editor content remounts view.dom (React's development double mount among
            // others); the layer follows it.
            if (layer.previousSibling !== current.dom) current.dom.after(layer);
            const base = layer.getBoundingClientRect();
            const seen = new Set<number>();
            for (const decoration of decorations?.find() ?? []) {
              if (!isCaret(decoration)) continue;
              const clientId = Number(decoration.spec.key);
              const user = (peers?.getStates().get(clientId)?.user ?? {}) as PeerUser;
              let caret = carets.get(clientId);
              if (!caret) {
                const element = document.createElement("span");
                element.className = "meridian-collab-cursor";
                element.append(document.createElement("span"));
                element.firstElementChild?.classList.add("meridian-collab-cursor__label");
                layer.append(element);
                caret = { element, head: decoration.from };
                carets.set(clientId, caret);
              }
              caret.head = decoration.from;
              const at = current.coordsAtPos(decoration.from);
              const { element } = caret;
              element.style.setProperty("--caret-color", user.color ?? "");
              element.style.left = `${at.left - base.left}px`;
              element.style.top = `${at.top - base.top}px`;
              element.style.height = `${at.bottom - at.top}px`;
              const label = element.firstElementChild as HTMLElement;
              label.textContent =
                accountId && user.accountId === accountId ? t`You` : user.name || t`Someone`;
              seen.add(clientId);
            }
            for (const [clientId, caret] of carets) {
              if (seen.has(clientId)) continue;
              caret.element.remove();
              carets.delete(clientId);
            }
          };

          // Layout moves without a transaction: a resize rewraps lines, an image or font loads.
          const resize = new ResizeObserver(() => draw(view));
          resize.observe(view.dom);

          const release = getEditorChrome(editor)?.registerHoverAnchor<HTMLElement>({
            id: "peer-caret",
            probe: ({ x, y }) => {
              for (const { element, head } of carets.values()) {
                const box = element.getBoundingClientRect();
                if (x < box.left - REACH || x > box.right + REACH) continue;
                if (y < box.top - REACH || y > box.bottom) continue;
                const at = view.domAtPos(head).node;
                const owner = hoverOwner(view, at instanceof Element ? at : at.parentElement);
                return owner ? { owner, value: element } : null;
              }
              return null;
            },
            onSettle: (hovered) => {
              for (const { element } of carets.values())
                element.toggleAttribute("data-hovered", element === hovered);
            },
          });

          draw(view);
          return {
            update: draw,
            destroy: () => {
              release?.();
              resize.disconnect();
              layer.remove();
            },
          };
        },
      }),
    ];
  },
});
