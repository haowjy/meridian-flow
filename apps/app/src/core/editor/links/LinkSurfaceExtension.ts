/**
 * LinkSurfaceExtension — the one place the link lane touches the editor.
 *
 * It owns the click (follow or caret, `link-navigation.ts` decides), the hover
 * that reveals the destination, Ctrl+K, Alt+Enter, the right-click claim, and
 * how an internal link keeps its document across the clipboard. Whether a
 * link has landed anywhere is drawn by the link mark's own view
 * (`link-mark-view.ts`), which asks through the requester stored here.
 * Everything it decides is decided by the pure modules beside it; this file
 * reads the document, watches the pointer, and calls the stores.
 *
 * It also owns link clicks outright: the link mark used to cancel navigation
 * from its own plugin, which would now be a second opinion about the same
 * event. The schema says what a link IS; this says what pressing one DOES.
 *
 * Priority is left at the default — the kernel (1050) and object physics
 * (1040) both sit above, which is right: an object under the pointer is a
 * deeper owner than a mark on its text.
 */

import { type Editor, Extension } from "@tiptap/core";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { anchorRange, type EditorAnchor, resolveAnchorIn } from "../anchors";
import { getEditorChrome, hoverOwner } from "../chrome";
import { linkClipboardPlugin } from "./link-clipboard";
import {
  anchorLinkRange,
  type LinkSelection,
  linkAt,
  linkAtSelection,
  relocateLink,
} from "./link-commands";
import {
  followLink,
  type LinkFollowDisposition,
  type LinkFollowResult,
  linkClickIntent,
  MIDDLE_BUTTON,
} from "./link-navigation";
import { createLinkRequester } from "./link-requester";
import { createLinkAnswerCache, type LinkKey, linkKeyOfMark } from "./link-resolution";
import {
  getLinkAnswerCache,
  getLinkSurface,
  LINK_SURFACE_NAME,
  type LinkSurfaceStorage,
} from "./link-storage";
import { createLinkSurface, type LinkMenuTarget, type LinkPoint } from "./link-surface";
import { classifyLinkTarget } from "./link-target";

const linkSurfacePluginKey = new PluginKey(LINK_SURFACE_NAME);

/**
 * Open the link form over the current selection (§5.5, law 5). No
 * preconditions: a selection asks for a URL, a bare caret asks for text and a
 * URL, and a caret inside a link arrives pre-filled. Ctrl+K, the toolbar's
 * Link button, and the menu's Edit link all end here, so the surface has one
 * entry point rather than three.
 */
export function openLinkForm(editor: Editor | null): boolean {
  const surface = getLinkSurface(editor);
  if (!editor || !surface || !editor.isEditable) return false;
  surface.openForm(caretPoint(editor.view));
  return true;
}

/**
 * Follow a link, unless it is already known to be gone. A gone link is not
 * followable (it draws a text cursor), so its press is the editor's: the caret
 * lands, and Enter means Enter. A press before the answer arrives still
 * follows, and the follow then does nothing.
 */
function followUnlessGone(
  editor: Editor,
  key: LinkKey,
  disposition: LinkFollowDisposition,
): LinkFollowResult {
  const surface = getLinkSurface(editor);
  if (!surface || getLinkAnswerCache(editor)?.read(key)?.state === "gone") return "unavailable";
  return followLink(
    { target: classifyLinkTarget(key.href), ref: key.ref, disposition },
    surface.navigator,
  );
}

/** Follow the link at the selection (Alt+Enter, and the menu's Open link). */
function followLinkAtSelection(editor: Editor | null): boolean {
  const link = editor && linkAtSelection(editor);
  if (!editor || !link) return false;
  // Alt+Enter is the keyboard twin of a plain click, so it lands in the same
  // place a plain click would.
  return followUnlessGone(editor, linkKeyOfMark(link.attributes), "current") !== "unavailable";
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

    // What the current press started from: where the pointer was, and where
    // the writer's selection was before ProseMirror moved it. The selection is
    // an anchor rather than two numbers — a press and its click are two events,
    // and a peer's write can land between them.
    let press: { origin: LinkPoint; selection: EditorAnchor } | null = null;
    // Registered in `view()`, because the kernel owns the approach: its timing,
    // its pointer, and which block owns hover chrome at all.
    let releaseHover: (() => void) | null = null;

    /**
     * One answer for both buttons: cancel the browser, decide what the gesture
     * meant, and either follow or hand the press back for a caret.
     */
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
        travelledPx: travelFrom(started?.origin ?? null, event),
      });
      if (intent.action === "place-caret") return false;

      const followed = followUnlessGone(editor, linkKeyOf(view, anchor), intent.disposition);
      // Nothing to follow — an unrecognized href, a link known to be gone, or
      // an internal link with no navigator registered yet. A primary click
      // falls through so the caret still lands; a middle click has no caret to
      // fall through to, and the cancel above is the whole answer.
      if (followed === "unavailable") return button === MIDDLE_BUTTON;

      // The follow read the link. It did not also move the writer's place: they
      // come back from that tab to the sentence they left.
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

          // One question, answered from the pointer's last known place rather
          // than only from a mouse event: a hint left over a link the writer
          // scrolled away from names a destination that is not under their
          // hand. Moving between two elements inside one link changes nothing,
          // because the answer is the anchor either way.
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
                  followUnlessGone(editor, linkKeyOf(view, anchor), "current") !== "unavailable"
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

          return {
            destroy() {
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
            /**
             * The press is where the gesture starts, and where the writer's
             * place in the manuscript is still theirs. ProseMirror moves the
             * caret from here, so a follow has to know what it moved off.
             */
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
              // Non-primary covers the right button too in some browsers, and
              // that one belongs to the claim ladder.
              if (event.button !== MIDDLE_BUTTON) return false;
              return handleLinkPress(view, event, event.button);
            },
          },
        },
      }),
    ];
  },
});

/** The anchor element under a DOM node, when it belongs to this editor. */
function anchorIn(view: EditorView, node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const anchor = node.closest("a");
  return anchor instanceof HTMLElement && view.dom.contains(anchor) ? anchor : null;
}

/** What the menu shows and acts on, derived from the link as it stands now. */
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

/**
 * The stored link under a rendered anchor. The ref never reaches the DOM, so
 * it is read from the mark at the anchor's own start: one character in, a
 * one-character link reads the link after it. The rendered href stands in
 * when the anchor no longer maps to a link.
 */
function linkKeyOf(view: EditorView, anchor: HTMLElement): LinkKey {
  const link = linkAt(view.state, view.posAtDOM(anchor, 0));
  if (link) return linkKeyOfMark(link.attributes);
  return {
    ref: null,
    href: anchor.getAttribute("data-meridian-link") ?? anchor.getAttribute("href") ?? "",
  };
}

function travelFrom(origin: LinkPoint | null, event: MouseEvent): number {
  if (!origin) return 0;
  return Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y);
}

/**
 * Put the selection back where the press found it.
 *
 * ProseMirror places the caret on `mousedown`, long before the gesture is
 * known to be a follow, and preventing that would take drag-selection from a
 * link with it. So the caret moves and comes back, and what the writer keeps
 * is the end state: the place they return to from the new tab.
 *
 * Where the press found it is resolved from the held anchor rather than from the
 * numbers it had then. A peer who types one line up between the press and the
 * click moves every position in the document, and clamping stale numbers to the
 * document's size puts the caret in the middle of somebody else's sentence.
 */
function restoreSelection(view: EditorView, selection: EditorAnchor | undefined): void {
  const at = selection && resolveAnchorIn(view.state, selection);
  // Nothing to go back to: the writer's place was deleted while they pressed,
  // and the caret the click already placed is the honest answer.
  if (!at) return;
  const { doc, selection: current } = view.state;
  if (current.from === at.from && current.to === at.to) return;

  const size = doc.content.size;
  const $from = doc.resolve(Math.min(at.from, size));
  const $to = doc.resolve(Math.min(at.to, size));
  // `between` lands on the nearest valid text position rather than throwing,
  // which matters when a peer reshaped the block during the press.
  view.dispatch(view.state.tr.setSelection(TextSelection.between($from, $to)));
}

/** Where a summoned surface hangs: the near edge of the selection, on screen. */
function caretPoint(view: EditorView): LinkPoint {
  const coords = view.coordsAtPos(view.state.selection.from);
  return { x: coords.left, y: coords.bottom };
}
