/**
 * Wiki-Link Interaction Handlers
 *
 * Click-to-navigate and clipboard interop for wiki-links. Decoration building
 * has moved to wikiLinkScanner.ts (coordinated by the live preview plugin).
 *
 * Exports:
 * - createWikiLinkClickHandler() — DOM event handler for ref navigation
 * - createWikiLinkClipboardHandler() — copy/paste with Meridian payload
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { createMeridianClipboardExtension } from "@/core/clipboard/codemirrorExtension";
import {
  buildMeridianClipboardFromWikiText,
  meridianPayloadToWikiLinkText,
} from "./clipboardInterop";

const REF_TARGET_SELECTOR = ".cm-inline-ref[data-doc-path]";

// =============================================================================
// CLICK HANDLER
// =============================================================================

/**
 * Create a CM6 extension that handles clicks on wiki-link inline references.
 * Navigates to the referenced document when a resolved reference is clicked.
 * Shows create popover when a broken reference is clicked.
 *
 * @param onNavigate - Called with (docId, docPath) when a resolved ref is clicked
 * @param onBrokenClick - Called with (docPath, displayName, clickCoords) when a broken ref is clicked
 */
export function createWikiLinkClickHandler(
  onNavigate: (docId: string, docPath: string) => void,
  onBrokenClick?: (
    docPath: string,
    displayName: string,
    clickCoords: { x: number; y: number },
  ) => void,
): Extension {
  return EditorView.domEventHandlers({
    mousedown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const ref = target.closest<HTMLElement>(REF_TARGET_SELECTOR);
      if (!ref) return false;

      const docPath = ref.dataset.docPath;
      const docId = ref.dataset.docId;
      if (docId && docPath) {
        event.preventDefault();
        onNavigate(docId, docPath);
        return true;
      }

      // Broken link — show create popover
      if (!docId && docPath && onBrokenClick) {
        event.preventDefault();
        const displayName = ref.dataset.displayName ?? docPath;
        onBrokenClick(docPath, displayName, {
          x: event.clientX,
          y: event.clientY,
        });
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
