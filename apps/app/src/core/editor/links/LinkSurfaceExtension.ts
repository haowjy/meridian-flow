import { parseLinkRef } from "@meridian/contracts";
import { type Editor, Extension } from "@tiptap/core";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { uploads } from "@/core/uploads/upload-store";

import { anchorRange, type EditorAnchor, resolveAnchorIn } from "../anchors";
import { getEditorChrome, hoverOwner, pastSlop } from "../chrome";
import { linkClipboardPlugin } from "./link-clipboard";
import {
  anchorLinkRange,
  type LinkSelection,
  linkAt,
  linkAtSelection,
  linkText,
  relocateLink,
} from "./link-commands";
import {
  followLink,
  type LinkFollowResult,
  linkClickIntent,
  MIDDLE_BUTTON,
} from "./link-navigation";
import { createLinkRequester } from "./link-requester";
import {
  createLinkAnswerCache,
  goneLinkDocumentId,
  type LinkKey,
  linkFolderId,
  linkKeyOfMark,
} from "./link-resolution";
import {
  getLinkAnswerCache,
  getLinkSurface,
  LINK_SURFACE_NAME,
  type LinkSurfaceStorage,
} from "./link-storage";
import { createLinkSurface, type LinkMenuTarget, type LinkPoint } from "./link-surface";
import { classifyLinkTarget } from "./link-target";

const linkSurfacePluginKey = new PluginKey(LINK_SURFACE_NAME);

export function openLinkForm(editor: Editor | null): boolean {
  const surface = getLinkSurface(editor);
  if (!editor || !surface || !editor.isEditable) return false;
  surface.openForm(caretPoint(editor.view));
  return true;
}

export function followLinkFrom(editor: Editor, key: LinkKey, at: LinkPoint): LinkFollowResult {
  const pending = parseLinkRef(key.ref);
  if (pending?.kind === "doc") {
    const upload = uploads.of(pending.documentId);
    if (upload?.kind === "failed") {
      uploads.retry(pending.documentId);
      return "navigated";
    }
    if (upload) return "unavailable";
  }
  const surface = getLinkSurface(editor);
  const answer = getLinkAnswerCache(editor)?.read(key) ?? null;
  if (!surface || (answer?.state === "gone" && !goneLinkDocumentId(answer, key)))
    return "unavailable";
  const folderId = linkFolderId(answer, key);
  if (folderId) {
    if (!surface.navigator) return "unavailable";
    surface.openFolder({ folderId, at });
    return "navigated";
  }
  return followLink({ target: classifyLinkTarget(key.href), ref: key.ref }, surface.navigator);
}

function followLinkAtSelection(editor: Editor | null): boolean {
  const link = editor && linkAtSelection(editor);
  if (!editor || !link) return false;
  return (
    followLinkFrom(editor, linkKeyOfMark(link.attributes), caretPoint(editor.view)) !==
    "unavailable"
  );
}

export const LinkSurfaceExtension = Extension.create({
  name: LINK_SURFACE_NAME,

  addStorage(): LinkSurfaceStorage {
    const resolution = createLinkAnswerCache();
    return {
      surface: createLinkSurface(),
      resolution,
      requester: createLinkRequester(resolution),
    };
  },

  onDestroy() {
    this.storage.surface.destroy();
    this.storage.resolution.destroy();
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { surface, resolution } = this.storage;

    let press: { origin: LinkPoint; selection: EditorAnchor } | null = null;
    let releaseHover: (() => void) | null = null;

    const handleLinkPress = (view: EditorView, event: MouseEvent, button: number): boolean => {
      const anchor = anchorIn(view, event.target);
      if (!anchor) return false;
      event.preventDefault();

      const started = press;
      press = null;
      const intent = linkClickIntent({
        button,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        swept: started?.origin
          ? pastSlop(event.clientX - started.origin.x, event.clientY - started.origin.y)
          : false,
      });
      if (intent.action === "place-caret") return false;

      const followed = followLinkFrom(editor, linkKeyOf(view, anchor), belowAnchor(anchor));
      if (followed === "unavailable") return button === MIDDLE_BUTTON;

      restoreSelection(view, started?.selection);
      return true;
    };

    return [
      linkClipboardPlugin(editor.schema, resolution),

      new Plugin({
        key: linkSurfacePluginKey,

        /**
         * Registration rides the view's lifetime rather than TipTap's `create`
         * event, which is emitted a macrotask late — long enough for the first
         * Ctrl+K to miss it.
         */
        view(view) {
          const chrome = getEditorChrome(editor);

          releaseHover =
            chrome?.registerHoverAnchor<HTMLElement>({
              id: "link-hint",
              probe: ({ element }) => {
                const anchor = anchorIn(view, element);
                if (!anchor) return null;
                const owner = hoverOwner(view, anchor);
                return owner ? { owner, value: anchor } : null;
              },
              onSettle: (element) => {
                const key = element && linkKeyOf(view, element);
                const target = key && classifyLinkTarget(key.href);
                surface.showHint(
                  target && element && key ? { element, target, ref: key.ref } : null,
                );
              },
            }) ?? null;

          const openKeyboardMenu = () => {
            const anchor = anchorIn(view, document.activeElement);
            const link = anchor
              ? linkAt(view.state, view.posAtDOM(anchor, 0) + 1)
              : linkAtSelection(editor);
            if (!link) return false;
            const rect = anchor?.getBoundingClientRect();
            surface.openMenu({
              at: rect ? { x: rect.left, y: rect.bottom } : caretPoint(view),
              ...menuTarget(view.state, link),
            });
            return true;
          };
          const releaseKeymap = chrome?.registerKeymap({
            id: "link-surface",
            scope: "document",
            bindings: {
              "Mod-k": () => openLinkForm(editor),
              "Alt-Enter": () => followLinkAtSelection(editor),
              Enter: () => {
                const anchor = anchorIn(view, document.activeElement);
                if (!anchor) return false;
                return (
                  followLinkFrom(editor, linkKeyOf(view, anchor), belowAnchor(anchor)) !==
                  "unavailable"
                );
              },
              ContextMenu: openKeyboardMenu,
              "Shift-F10": openKeyboardMenu,
            },
          });

          const releaseClaim = chrome?.registerContextClaim({
            id: "link",
            claim: ({ element, event }) => {
              const anchor = anchorIn(view, element);
              if (!anchor) return false;
              // One character INTO the anchor: a link mark always covers at
              // least one character, and the position at its front edge is
              // ambiguous between the link and the text before it.
              const link = linkAt(view.state, view.posAtDOM(anchor, 0) + 1);
              if (!link) return false;

              surface.openMenu({
                at: { x: event.clientX, y: event.clientY },
                ...menuTarget(view.state, link),
              });
              return true;
            },
          });

          // The menu outlives the state it opened on. Every verb it carries
          // rewrites a range, and a peer typing one line up moves that range,
          // so it follows the document rather than trusting a snapshot.
          const followDocument = ({ transaction }: { transaction: Transaction }) => {
            const menu = surface.state.menu;
            if (!transaction.docChanged || !menu) return;
            const current = relocateLink(view.state, menu, transaction.mapping);
            surface.retargetMenu(current && menuTarget(view.state, current));
          };
          editor.on("transaction", followDocument);

          const announceDrag = (event: DragEvent) => {
            if (!view.dragging || !surface.dragSource) return;
            const dragged = selectedLinkEntry(view, event);
            if (dragged) surface.dragSource({ ...dragged, event });
          };
          view.dom.addEventListener("dragstart", announceDrag);

          return {
            destroy() {
              view.dom.removeEventListener("dragstart", announceDrag);
              editor.off("transaction", followDocument);
              releaseHover?.();
              releaseHover = null;
              releaseKeymap?.();
              releaseClaim?.();
            },
          };
        },

        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              const { from, to } = view.state.selection;
              press = {
                origin: { x: event.clientX, y: event.clientY },
                selection: anchorRange(view.state, { from, to }),
              };
              return false;
            },

            /**
             * A link in the manuscript never navigates the browser: the draft
             * would go with it. `preventDefault` is unconditional, and what
             * happens instead is the design's decision, not the browser's.
             */
            click(view, event) {
              return handleLinkPress(view, event, event.button);
            },

            /**
             * The middle button navigates through `auxclick`, which `click`
             * never sees. Left alone it is the one path where a raw href in
             * the manuscript reaches the browser's own URL resolution — and an
             * internal spelling resolved that way lands on a page that has
             * nothing to do with the manuscript.
             */
            auxclick(view, event) {
              if (event.button !== MIDDLE_BUTTON) return false;
              return handleLinkPress(view, event, event.button);
            },
          },
        },
      }),
    ];
  },
});

function selectedLinkEntry(
  view: EditorView,
  event: DragEvent,
): { entry: { kind: "file" | "folder"; id: string }; name: string } | null {
  const { from, to, empty } = view.state.selection;
  if (empty) return null;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (at === undefined || at < from || at > to) return null;
  const link = linkAt(view.state, from + 1) ?? linkAt(view.state, from);
  if (!link || link.from > from || link.to < to) return null;
  const ref = parseLinkRef(linkKeyOfMark(link.attributes).ref);
  const name = linkText(view.state.doc, link.from, link.to).text;
  if (ref?.kind === "doc") return { entry: { kind: "file", id: ref.documentId }, name };
  if (ref?.kind === "folder") return { entry: { kind: "folder", id: ref.folderId }, name };
  return null;
}

function anchorIn(view: EditorView, node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const anchor = node.closest("a");
  return anchor instanceof HTMLElement && view.dom.contains(anchor) ? anchor : null;
}

function menuTarget(state: EditorState, link: LinkSelection): LinkMenuTarget {
  const { ref, href } = linkKeyOfMark(link.attributes);
  return {
    anchor: anchorLinkRange(state, { from: link.from, to: link.to }),
    href,
    ref,
    target: classifyLinkTarget(href),
    identity: link.identity,
  };
}

function linkKeyOf(view: EditorView, anchor: HTMLElement): LinkKey {
  const link = linkAt(view.state, view.posAtDOM(anchor, 0));
  if (link) return linkKeyOfMark(link.attributes);
  return {
    ref: null,
    href: anchor.getAttribute("data-meridian-link") ?? anchor.getAttribute("href") ?? "",
  };
}

function restoreSelection(view: EditorView, selection: EditorAnchor | undefined): void {
  const at = selection && resolveAnchorIn(view.state, selection);
  if (!at) return;
  const { doc, selection: current } = view.state;
  if (current.from === at.from && current.to === at.to) return;

  const size = doc.content.size;
  const $from = doc.resolve(Math.min(at.from, size));
  const $to = doc.resolve(Math.min(at.to, size));
  view.dispatch(view.state.tr.setSelection(TextSelection.between($from, $to)));
}

function belowAnchor(anchor: HTMLElement): LinkPoint {
  const rect = anchor.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

function caretPoint(view: EditorView): LinkPoint {
  const coords = view.coordsAtPos(view.state.selection.from);
  return { x: coords.left, y: coords.bottom };
}
