/**
 * Wiki-Link ViewPlugin
 *
 * CM6 ViewPlugin that scans for `@[[...]]` wiki-link patterns and replaces
 * them with pill widget decorations. Obsidian-style cursor proximity:
 * when the cursor is inside a wiki-link range, the raw syntax is shown
 * for editing; when the cursor moves away, the pill renders.
 *
 * Also exports a click handler factory for pill → document navigation.
 */

import {
  ViewPlugin,
  Decoration,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { createMeridianClipboardExtension } from "@/core/clipboard/codemirrorExtension";
import { WikiLinkWidget } from "./WikiLinkWidget";
import { findWikiLinks } from "./wikiLinkRegex";
import {
  buildMeridianClipboardFromWikiText,
  meridianPayloadToWikiLinkText,
} from "./clipboardInterop";
import { resolveDocumentByPath } from "./resolveDocument";

// =============================================================================
// VIEW PLUGIN
// =============================================================================

/**
 * Build decorations for all wiki-links in visible ranges.
 * Skips decoration when cursor is inside the link (reveals raw syntax).
 */
function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];
  const cursor = view.state.selection.main.head;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const links = findWikiLinks(text, from);

    for (const link of links) {
      // Obsidian-style: if cursor is inside this link, skip decoration
      // so user sees raw @[[...]] syntax and can edit it
      // Treat ranges as [from, to): cursor at `to` is already outside the link.
      // This avoids edge flicker when caret sits immediately after a pill.
      if (cursor >= link.from && cursor < link.to) {
        continue;
      }

      const docId = resolveDocumentByPath(link.path)?.id ?? null;

      decorations.push({
        from: link.from,
        to: link.to,
        deco: Decoration.replace({
          widget: new WikiLinkWidget(link.path, link.displayName, docId),
        }),
      });
    }
  }

  // Decorations must be sorted by position
  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations.map((d) => d.deco.range(d.from, d.to)));
}

const wikiLinkViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Rebuild on doc change, selection change, or viewport change
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Create the wiki-link ViewPlugin extension.
 * Scans for @[[...]] patterns and renders them as pill widgets.
 */
export function createWikiLinkPlugin(): Extension {
  return wikiLinkViewPlugin;
}

// =============================================================================
// CLICK HANDLER
// =============================================================================

/**
 * Create a CM6 extension that handles clicks on wiki-link pill widgets.
 * Navigates to the referenced document when a resolved pill is clicked.
 * Shows create popover when a broken pill is clicked.
 *
 * @param onNavigate - Called with (docId, docPath) when a resolved pill is clicked
 * @param onBrokenClick - Called with (docPath, displayName, clickCoords) when a broken pill is clicked
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
      // Walk up to find the pill element (click may land on icon or name span)
      const pill = target.closest<HTMLElement>(
        ".cm-inline-pill[data-doc-path]",
      );
      if (!pill) return false;

      const docPath = pill.dataset.docPath;
      const docId = pill.dataset.docId;

      // Navigate if link is resolved (has docId)
      if (docId && docPath) {
        event.preventDefault();
        onNavigate(docId, docPath);
        return true;
      }

      // Broken link — show create popover
      if (!docId && docPath && onBrokenClick) {
        event.preventDefault();
        const displayName = pill.dataset.displayName ?? docPath;
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
 * - paste: accepts Meridian custom payload and inserts @[[...]] markdown
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
