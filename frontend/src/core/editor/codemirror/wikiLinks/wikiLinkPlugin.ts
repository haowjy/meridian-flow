/**
 * Wiki-Link Interaction Handlers
 *
 * Click-to-navigate, X-to-delete, and clipboard interop for wiki-links.
 * Decoration building lives in wikiLinkScanner.ts (coordinated by the
 * live preview plugin).
 *
 * Exports:
 * - createWikiLinkClickHandler() — DOM event handler for ref navigation + delete
 * - createWikiLinkClipboardHandler() — copy/paste with Meridian payload
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { createMeridianClipboardExtension } from "@/core/clipboard/codemirrorExtension";
import {
  buildMeridianClipboardFromWikiText,
  meridianPayloadToWikiLinkText,
} from "./clipboardInterop";
import { PILL_MARK_CLASS, ICON_AREA_WIDTH } from "@/shared/reference-pill";

const REF_TARGET_SELECTOR = `.${PILL_MARK_CLASS}[data-doc-path]`;

// =============================================================================
// CLICK HANDLER
// =============================================================================

/**
 * Create a CM6 extension that handles clicks on wiki-link inline references.
 *
 * - Click on text area -> navigate to document/folder via onRefClick
 * - Click on icon area (left ~16px) -> delete the entire [[...]] syntax
 *
 * The icon area shows an X on hover (via CSS), signaling delete affordance.
 *
 * @param onRefClick - Called with (id, refType, anchorEl) when a resolved ref is clicked.
 *                     Matches the `handlePillClick` signature from `usePillNavigation`.
 * @param onBrokenClick - Called with (docPath, displayName, clickCoords, refType) when a broken ref is clicked.
 *                        `refType` mirrors the resolved-ref pattern from `onRefClick` — "folder" when the
 *                        wiki-link had a trailing slash (`[[path/]]`), "document" otherwise.
 */
export function createWikiLinkClickHandler(
  onRefClick: (id: string, refType: string, anchorEl: HTMLElement) => void,
  onBrokenClick?: (
    docPath: string,
    displayName: string,
    clickCoords: { x: number; y: number },
    refType: "document" | "folder",
  ) => void,
): Extension {
  return EditorView.domEventHandlers({
    // Belt-and-suspenders for hybrid devices (touchscreen laptops where
    // @media (hover: hover) matches but touch is used): suppress CM6's
    // default mousedown handling on pill clicks so it doesn't place the
    // cursor and destroy the decoration before our pointerdown fires.
    mousedown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (target.closest<HTMLElement>(REF_TARGET_SELECTOR)) {
        return true; // "handled" — CM6 won't process further
      }
      return false;
    },

    // pointerdown fires before touchstart/mousedown on all platforms,
    // so the decoration is still in the DOM when this handler runs.
    // Using mousedown caused mobile taps to fail: touchstart moved the
    // cursor, CM6 removed the decoration, then synthetic mousedown
    // found nothing to click.
    pointerdown(event: PointerEvent, view: EditorView) {
      const target = event.target as HTMLElement;
      const ref = target.closest<HTMLElement>(REF_TARGET_SELECTOR);
      if (!ref) return false;

      const docPath = ref.dataset.docPath;

      // Icon-area click -> delete the entire [[...]] syntax.
      // The ::before pseudo-element shows an X on hover (CSS), so clicking
      // the left ~16px of the pill means "remove this reference".
      const rect = ref.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      if (clickX <= ICON_AREA_WIDTH) {
        const linkFrom = Number(ref.dataset.linkFrom);
        const linkTo = Number(ref.dataset.linkTo);
        if (!isNaN(linkFrom) && !isNaN(linkTo) && linkTo > linkFrom) {
          event.preventDefault();
          view.dispatch({
            changes: { from: linkFrom, to: linkTo },
          });
          return true;
        }
      }

      // Save selection before handling navigate/broken-link paths.
      // CM6's cursor placement logic runs in parallel with our handler —
      // it calculates position from coordinates and sets cursor regardless
      // of preventDefault(). We restore selection after CM6's default handler
      // runs via setTimeout. (Matches livePreview/plugin.ts pattern.)
      const savedSelection = view.state.selection;

      // Resolved ref — read type + id from data attrs set by scanner
      const refId = ref.dataset.refId;
      const refType = ref.dataset.refType ?? "document";
      if (refId) {
        event.preventDefault();
        onRefClick(refId, refType, ref);
        // Restore selection after CM6's default handler runs
        setTimeout(() => view.dispatch({ selection: savedSelection }), 0);
        return true;
      }

      // Broken link — show create popover
      if (!refId && docPath && onBrokenClick) {
        event.preventDefault();
        const displayName = ref.dataset.displayName ?? docPath;
        const refType =
          ref.dataset.folderHint === "true" ? "folder" : "document";
        onBrokenClick(
          docPath,
          displayName,
          {
            x: event.clientX,
            y: event.clientY,
          },
          refType,
        );
        // Restore selection after CM6's default handler runs
        setTimeout(() => view.dispatch({ selection: savedSelection }), 0);
        return true;
      }

      return false;
    },
  });
}

/**
 * Clipboard interop for wiki-links:
 * - copy/cut: adds Meridian custom payload + plain markdown text
 * - paste: accepts Meridian custom payload and inserts [[...]] markdown
 */
export function createWikiLinkClipboardHandler(): Extension {
  return createMeridianClipboardExtension({
    extractSelection(view, from, to) {
      const selected = view.state.sliceDoc(from, to);
      const payload = buildMeridianClipboardFromWikiText(selected);
      if (!payload) return null;
      return { payload, plainText: selected };
    },
    insertPayload(view, payload, from, to) {
      const markdown = meridianPayloadToWikiLinkText(payload);
      if (!markdown) return false;
      view.dispatch({
        changes: { from, to, insert: markdown },
        selection: { anchor: from + markdown.length },
      });
      return true;
    },
    toPlainTextFallback(payload) {
      return meridianPayloadToWikiLinkText(payload);
    },
    fromPlainTextFallback(text) {
      return buildMeridianClipboardFromWikiText(text);
    },
  });
}
