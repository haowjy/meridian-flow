import { t } from "@lingui/core/macro";
import type { RoomDocs } from "@meridian/document-model";
import { resolveCursor } from "@meridian/loro-prosemirror";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { getEditorChrome, hoverOwner, watchManuscriptLayout } from "../chrome";
import type { LocalPresenceFields } from "../local-presence";
import { decodePoint, encodePoint, pointAt } from "../loro-points";

const REACH = 4;

export type PeerUser = { accountId?: string; name?: string; color?: string };

const key = new PluginKey<DecorationSet>("peerCarets");
const REDRAW = "peerCaretsRedraw";

function wireCursor(docs: RoomDocs, state: EditorState) {
  const anchor = pointAt(docs, state.doc, state.selection.anchor);
  const head = pointAt(docs, state.doc, state.selection.head);
  return anchor && head ? { anchor: encodePoint(anchor), head: encodePoint(head) } : null;
}

type PeerCaret = { client: string; head: number; from: number; to: number; user: PeerUser };

function peerCarets(docs: RoomDocs, presence: LocalPresenceFields, doc: Node): PeerCaret[] {
  if (docs.isFreed) return [];
  const out: PeerCaret[] = [];
  for (const [client, state] of presence.peers.getStates()) {
    if (client === presence.peers.clientID) continue;
    const cursor = state.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
    const headPoint = decodePoint(cursor?.head);
    const anchorPoint = decodePoint(cursor?.anchor);
    const head = headPoint && resolveCursor(docs, doc, headPoint);
    const anchor = (anchorPoint && resolveCursor(docs, doc, anchorPoint)) ?? head;
    if (head == null || anchor == null) continue;
    out.push({
      client,
      head,
      from: Math.min(anchor, head),
      to: Math.max(anchor, head),
      user: (state.user as PeerUser | undefined) ?? {},
    });
  }
  return out;
}

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

export type PeerCaretsOptions = {
  docs: RoomDocs | null;
  presence: LocalPresenceFields | null;
  user: PeerUser;
};

/**
 * Peers' carets and selections, and this editor's own caret on the wire. A peer's selection is a
 * highlight; its caret is drawn on a layer over the prose (not a widget in the line, which would
 * split the browser's selection anchor around it), and its name shows while the pointer is on or
 * beside its line, read from the editor's one pointer source.
 */
export const PeerCarets = Extension.create<PeerCaretsOptions>({
  name: "peerCarets",
  addOptions: () => ({ docs: null, presence: null, user: {} }),
  addProseMirrorPlugins() {
    const { editor } = this;
    const { docs, presence, user } = this.options;
    if (!docs || !presence) return [];
    const self = user.accountId;
    presence.setField("user", user);

    const decorate = (doc: Node) =>
      DecorationSet.create(
        doc,
        peerCarets(docs, presence, doc)
          .filter((caret) => caret.from < caret.to)
          .map((caret) =>
            Decoration.inline(caret.from, caret.to, {
              nodeName: "span",
              class: "meridian-collab-selection",
              style: `--caret-color: ${String(caret.user.color ?? "")}`,
            }),
          ),
      );

    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, value, _old, state) =>
            tr.docChanged || tr.getMeta(REDRAW) ? decorate(state.doc) : value,
        },
        props: { decorations: (state) => key.getState(state) ?? null },
        view(view) {
          const layer = document.createElement("div");
          layer.className = "meridian-peer-carets";
          layer.setAttribute("aria-hidden", "true");
          view.dom.after(layer);
          const carets = new Map<string, { element: HTMLElement; head: number }>();
          let published = "";

          const publish = () => {
            if (editor.isDestroyed || docs.isFreed) return;
            const cursor = view.hasFocus() ? wireCursor(docs, view.state) : null;
            const next = JSON.stringify(cursor);
            if (next === published) return;
            published = next;
            presence.setField("cursor", cursor);
          };

          const draw = () => {
            if (editor.isDestroyed) return;
            const heads = peerCarets(docs, presence, view.state.doc);
            for (const [client, caret] of carets) {
              if (heads.some((head) => head.client === client)) continue;
              caret.element.remove();
              carets.delete(client);
            }
            if (heads.length === 0) return;
            // The editor content remounts view.dom (React's development double mount among
            // others); the layer follows it.
            if (layer.previousSibling !== view.dom) view.dom.after(layer);
            const base = layer.getBoundingClientRect();
            for (const peer of heads) {
              let caret = carets.get(peer.client);
              if (!caret) {
                const element = document.createElement("span");
                element.className = "meridian-collab-cursor";
                const label = document.createElement("span");
                label.className = "meridian-collab-cursor__label";
                element.append(label);
                layer.append(element);
                caret = { element, head: peer.head };
                carets.set(peer.client, caret);
              }
              caret.head = peer.head;
              const at = view.coordsAtPos(peer.head);
              const { element } = caret;
              element.hidden = pannedAway(view, peer.head, at.left);
              element.style.setProperty("--caret-color", peer.user.color ?? "");
              element.style.left = `${at.left - base.left}px`;
              element.style.top = `${at.top - base.top}px`;
              element.style.height = `${at.bottom - at.top}px`;
              (element.firstElementChild as HTMLElement).textContent =
                self && peer.user.accountId === self ? t`You` : peer.user.name || t`Someone`;
            }
          };

          // Coalesced and out of the current dispatch: our own field write notifies too.
          let scheduled = false;
          const onPeers = () => {
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (editor.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(REDRAW, true).setMeta("addToHistory", false));
              draw();
            });
          };
          presence.peers.on("change", onPeers);
          const onBlur = () => publish();
          view.dom.addEventListener("blur", onBlur);
          view.dom.addEventListener("focus", onBlur);

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
            update: () => {
              publish();
              draw();
            },
            destroy: () => {
              presence.peers.off("change", onPeers);
              view.dom.removeEventListener("blur", onBlur);
              view.dom.removeEventListener("focus", onBlur);
              if (published !== "" && published !== "null") presence.setField("cursor", null);
              release?.();
              stopWatching();
              layer.remove();
            },
          };
        },
      }),
    ];
  },
});
