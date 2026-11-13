import { t } from "@lingui/core/macro";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { type Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { yCursorPluginKey } from "@tiptap/y-tiptap";
import { getEditorChrome, hoverOwner, watchManuscriptLayout } from "../chrome";

/** How far either side of a peer's caret line still names the peer, in px. */
const REACH = 4;

type PeerUser = { accountId?: string; name?: string; color?: string };
type Awareness = { getStates: () => Map<number, { user?: PeerUser }> };

/** A peer's caret: the widget y-prosemirror places at its head. Its spec carries `side`. */
function isCaret(decoration: Decoration): boolean {
  return "side" in decoration.spec;
}

const selectionsOnly = new WeakMap<DecorationSet, DecorationSet>();

/**
 * The text at `pos` is scrolled out of a box that pans on its own (a wide table, a long code
 * line). The layer sits outside those boxes' clip, so such a caret is hidden rather than drawn
 * over the margin.
 */
function pannedAway(view: EditorView, pos: number, x: number): boolean {
  const at = view.domAtPos(pos).node;
  for (
    let element = at instanceof Element ? at : at.parentElement;
    element && element !== view.dom;
    element = element.parentElement
  ) {
    if (element.scrollWidth <= element.clientWidth) continue;
    if (getComputedStyle(element).overflowX === "visible") continue;
    const box = element.getBoundingClientRect();
    if (x < box.left || x > box.right) return true;
  }
  return false;
}

/**
 * Peers' carets and selections. y-prosemirror draws a caret as a widget: a non-editable node in
 * the line, and a press just after it gives the browser a selection anchor on one side of it and
 * ProseMirror the other, so a drag starting there selects nothing. Its selection highlights stay;
 * its widgets are dropped and each caret is drawn from the widget's position on a layer over the
 * prose, which scrolls with the page and takes no pointer. A caret's name shows while the pointer
 * is on or beside its line, read from the editor's one pointer source.
 */
export const PeerCarets = CollaborationCaret.extend({
  addProseMirrorPlugins() {
    const { editor } = this;
    const awareness = this.options.provider.awareness as Awareness;
    const self = (this.options.user as PeerUser).accountId;
    const cursors = (this.parent?.() ?? []).map((plugin) => {
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

    const layerPlugin = new Plugin({
      key: new PluginKey("peerCaretLayer"),
      view(view) {
        const layer = document.createElement("div");
        layer.className = "meridian-peer-carets";
        layer.setAttribute("aria-hidden", "true");
        view.dom.after(layer);
        const carets = new Map<number, { element: HTMLElement; head: number }>();

        const draw = () => {
          if (editor.isDestroyed) return;
          const decorations = yCursorPluginKey.getState(view.state) as DecorationSet | undefined;
          const heads = (decorations?.find() ?? []).filter(isCaret);
          for (const [clientId, caret] of carets) {
            if (heads.some((decoration) => Number(decoration.spec.key) === clientId)) continue;
            caret.element.remove();
            carets.delete(clientId);
          }
          if (heads.length === 0) return;
          // The editor content remounts view.dom (React's development double mount among
          // others); the layer follows it.
          if (layer.previousSibling !== view.dom) view.dom.after(layer);
          const base = layer.getBoundingClientRect();
          for (const decoration of heads) {
            const clientId = Number(decoration.spec.key);
            const user = awareness.getStates().get(clientId)?.user ?? {};
            let caret = carets.get(clientId);
            if (!caret) {
              const element = document.createElement("span");
              element.className = "meridian-collab-cursor";
              const label = document.createElement("span");
              label.className = "meridian-collab-cursor__label";
              element.append(label);
              layer.append(element);
              caret = { element, head: decoration.from };
              carets.set(clientId, caret);
            }
            caret.head = decoration.from;
            const at = view.coordsAtPos(decoration.from);
            const { element } = caret;
            element.hidden = pannedAway(view, decoration.from, at.left);
            element.style.setProperty("--caret-color", user.color ?? "");
            element.style.left = `${at.left - base.left}px`;
            element.style.top = `${at.top - base.top}px`;
            element.style.height = `${at.bottom - at.top}px`;
            (element.firstElementChild as HTMLElement).textContent =
              self && user.accountId === self ? t`You` : user.name || t`Someone`;
          }
        };

        const stopWatching = watchManuscriptLayout(editor, [], draw);
        const release = getEditorChrome(editor)?.registerHoverAnchor<HTMLElement>({
          id: "peer-caret",
          probe: ({ x, y }) => {
            for (const { element, head } of carets.values()) {
              if (element.hidden) continue;
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

        draw();
        return {
          destroy: () => {
            release?.();
            stopWatching();
            layer.remove();
          },
        };
      },
    });

    return [...cursors, layerPlugin];
  },
});
