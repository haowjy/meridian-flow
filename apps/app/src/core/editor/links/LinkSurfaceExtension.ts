/**
 * LinkSurfaceExtension — the one place the link lane touches the editor.
 *
 * It owns the click (follow or caret, `link-navigation.ts` decides), the hover
 * that reveals the destination, Ctrl+K, Alt+Enter, and the right-click claim.
 * Everything it decides is decided by the pure modules beside it; this file
 * reads the document, watches the pointer, and calls the store.
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
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { getEditorChrome, type HoverIntent } from "../chrome";
import { linkAt, linkAtSelection, linkHref } from "./link-commands";
import { followLink, linkClickAction } from "./link-navigation";
import { createLinkSurface, type LinkPoint, type LinkSurface } from "./link-surface";
import { classifyLinkTarget } from "./link-target";

const LINK_SURFACE_NAME = "meridianLinkSurface";

export const linkSurfacePluginKey = new PluginKey(LINK_SURFACE_NAME);

type LinkSurfaceStorage = { surface: LinkSurface };

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
  const followed = followLink(classifyLinkTarget(linkHref(link)), surface.navigator);
  return followed !== "unavailable";
}

export const LinkSurfaceExtension = Extension.create({
  name: LINK_SURFACE_NAME,

  addStorage(): LinkSurfaceStorage {
    return { surface: createLinkSurface() };
  },

  onDestroy() {
    this.storage.surface.destroy();
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { surface } = this.storage;

    // Where the press that produced the current click started. A click that
    // travelled is a sweep, and a sweep over a link is a selection (law 7).
    let pressOrigin: LinkPoint | null = null;
    // Created in `view()`, because the kernel is what supplies the timing and
    // it must be able to cancel this one when a gesture starts.
    let hover: HoverIntent<HTMLElement> | null = null;

    return [
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

              const href = linkHref(link);
              surface.openMenu({
                at: { x: event.clientX, y: event.clientY },
                range: { from: link.from, to: link.to },
                href,
                target: classifyLinkTarget(href),
              });
              return true;
            },
          });

          return {
            destroy() {
              hover?.dispose();
              hover = null;
              releaseKeymap?.();
              releaseClaim?.();
            },
          };
        },

        props: {
          handleDOMEvents: {
            mousedown(_view, event) {
              pressOrigin = { x: event.clientX, y: event.clientY };
              return false;
            },

            /**
             * A link in the manuscript never navigates the browser: the draft
             * would go with it. `preventDefault` is unconditional, and what
             * happens instead is the design's decision, not the browser's.
             */
            click(view, event) {
              const anchor = anchorIn(view, event.target);
              if (!anchor) return false;
              event.preventDefault();

              const action = linkClickAction({
                altKey: event.altKey,
                travelledPx: travelFrom(pressOrigin, event),
              });
              pressOrigin = null;
              if (action === "place-caret") return false;

              const followed = followLink(classifyLinkTarget(hrefOf(anchor)), surface.navigator);
              // Nothing to follow — an unrecognized href, or an internal link
              // with no navigator registered yet. Fall through so the click
              // still places the caret rather than doing nothing at all.
              return followed !== "unavailable";
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

function hrefOf(element: HTMLElement): string {
  return element.getAttribute("href") ?? "";
}

function travelFrom(origin: LinkPoint | null, event: MouseEvent): number {
  if (!origin) return 0;
  return Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y);
}

/** Where a summoned surface hangs: the near edge of the selection, on screen. */
function caretPoint(view: EditorView): LinkPoint {
  const coords = view.coordsAtPos(view.state.selection.from);
  return { x: coords.left, y: coords.bottom };
}
