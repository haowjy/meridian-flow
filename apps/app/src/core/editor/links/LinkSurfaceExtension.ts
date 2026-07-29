/**
 * LinkSurfaceExtension — the one place the link lane touches the editor.
 *
 * It owns the click (follow or caret, `link-navigation.ts` decides), the hover
 * that reveals the destination, Ctrl+K, Alt+Enter, the right-click claim, and
 * the decoration that says whether an internal link has landed anywhere yet.
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

import { getEditorChrome, type HoverIntent } from "../chrome";
import {
  anchorLinkRange,
  type LinkSelection,
  linkAt,
  linkAtSelection,
  linkHref,
  relocateLink,
} from "./link-commands";
import { followLink, linkClickIntent, MIDDLE_BUTTON } from "./link-navigation";
import { createLinkResolution, type LinkResolution } from "./link-resolution";
import { linkResolutionPlugin } from "./link-resolution-decorations";
import {
  createLinkSurface,
  type LinkMenuTarget,
  type LinkPoint,
  type LinkSurface,
} from "./link-surface";
import { classifyLinkTarget } from "./link-target";

const LINK_SURFACE_NAME = "meridianLinkSurface";

export const linkSurfacePluginKey = new PluginKey(LINK_SURFACE_NAME);

type LinkSurfaceStorage = { surface: LinkSurface; resolution: LinkResolution };

declare module "@tiptap/core" {
  interface Storage {
    meridianLinkSurface: LinkSurfaceStorage;
  }
}

/** The link runtime for this editor, or null on one that never mounted it. */
export function getLinkSurface(editor: Editor | null | undefined): LinkSurface | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[LINK_SURFACE_NAME]?.surface ?? null;
}

/**
 * Where this editor's internal links point, or null on one that never mounted
 * the lane. Separate from the surface store because it answers a different
 * question: the surface knows which link the writer is working on, and this
 * knows what any of them addresses.
 */
export function getLinkResolution(editor: Editor | null | undefined): LinkResolution | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[LINK_SURFACE_NAME]?.resolution ?? null;
}

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

/** Follow the link at the selection (Alt+Enter, and the menu's Open link). */
export function followLinkAtSelection(editor: Editor | null): boolean {
  const surface = getLinkSurface(editor);
  if (!editor || !surface) return false;
  const link = linkAtSelection(editor);
  if (!link) return false;
  // Alt+Enter is the keyboard twin of a plain click, so it lands in the same
  // place a plain click would.
  const followed = followLink(
    { target: classifyLinkTarget(linkHref(link)), disposition: "current" },
    surface.navigator,
  );
  return followed !== "unavailable";
}

export const LinkSurfaceExtension = Extension.create({
  name: LINK_SURFACE_NAME,

  addStorage(): LinkSurfaceStorage {
    return { surface: createLinkSurface(), resolution: createLinkResolution() };
  },

  onDestroy() {
    this.storage.surface.destroy();
    this.storage.resolution.destroy();
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { surface, resolution } = this.storage;

    // What the current press started from: where the pointer was, and where
    // the writer's selection was before ProseMirror moved it.
    let press: { origin: LinkPoint; selection: { from: number; to: number } } | null = null;
    // Created in `view()`, because the kernel is what supplies the timing and
    // it must be able to cancel this one when a gesture starts.
    let hover: HoverIntent<HTMLElement> | null = null;

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

      const followed = followLink(
        { target: classifyLinkTarget(hrefOf(anchor)), disposition: intent.disposition },
        surface.navigator,
      );
      // Nothing to follow — an unrecognized href, or an internal link with no
      // navigator registered yet. A primary click falls through so the caret
      // still lands; a middle click has no caret to fall through to, and the
      // cancel above is the whole answer.
      if (followed === "unavailable") return button === MIDDLE_BUTTON;

      // The follow read the link. It did not also move the writer's place: they
      // come back from that tab to the sentence they left.
      restoreSelection(view, started?.selection);
      return true;
    };

    return [
      linkResolutionPlugin(resolution),

      new Plugin({
        key: linkSurfacePluginKey,

        /**
         * Registration rides the view's lifetime rather than TipTap's `create`
         * event, which is emitted a macrotask late — long enough for the first
         * Ctrl+K to miss it.
         */
        view(view) {
          const chrome = getEditorChrome(editor);

          hover =
            chrome?.createHoverIntent<HTMLElement>({
              onSettle: (element) => {
                const target = element && classifyLinkTarget(hrefOf(element));
                surface.showHint(target && element ? { element, target } : null);
              },
            }) ?? null;

          const releaseKeymap = chrome?.registerKeymap({
            id: "link-surface",
            scope: "document",
            bindings: {
              "Mod-k": () => openLinkForm(editor),
              "Alt-Enter": () => followLinkAtSelection(editor),
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
              hover?.dispose();
              hover = null;
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
              press = {
                origin: { x: event.clientX, y: event.clientY },
                selection: { from: view.state.selection.from, to: view.state.selection.to },
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

            mouseover(view, event) {
              const anchor = anchorIn(view, event.target);
              if (anchor) hover?.enter(anchor);
              else hover?.leave();
              return false;
            },

            mouseout(view, event) {
              // Moving between two elements inside the same link is not a
              // leave; the hint would blink for every word it spans.
              if (anchorIn(view, event.relatedTarget)) return false;
              hover?.leave();
              return false;
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
  const href = linkHref(link);
  return {
    anchor: anchorLinkRange(state, { from: link.from, to: link.to }),
    href,
    target: classifyLinkTarget(href),
    identity: link.identity,
  };
}

function hrefOf(element: HTMLElement): string {
  return element.getAttribute("href") ?? "";
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
 */
function restoreSelection(
  view: EditorView,
  selection: { from: number; to: number } | undefined,
): void {
  if (!selection) return;
  const { doc, selection: current } = view.state;
  if (current.from === selection.from && current.to === selection.to) return;

  const size = doc.content.size;
  const $from = doc.resolve(Math.min(selection.from, size));
  const $to = doc.resolve(Math.min(selection.to, size));
  // `between` lands on the nearest valid text position rather than throwing,
  // which matters when a peer reshaped the block during the press.
  view.dispatch(view.state.tr.setSelection(TextSelection.between($from, $to)));
}

/** Where a summoned surface hangs: the near edge of the selection, on screen. */
function caretPoint(view: EditorView): LinkPoint {
  const coords = view.coordsAtPos(view.state.selection.from);
  return { x: coords.left, y: coords.bottom };
}
