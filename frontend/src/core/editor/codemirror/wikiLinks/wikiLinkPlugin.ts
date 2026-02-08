/**
 * Wiki-Link ViewPlugin
 *
 * CM6 ViewPlugin that scans for `[[...]]` (and legacy `@[[...]]`) wiki-link
 * patterns and renders them as styled inline text using mark decorations.
 * Follows the inline-code pattern: replace opening syntax with icon widget
 * (Decoration.replace({ widget })), style visible text with Decoration.mark,
 * and hide closing syntax with Decoration.replace.
 *
 * Obsidian-style cursor proximity: when the cursor is inside a wiki-link range,
 * raw syntax is shown for editing; when the cursor moves away, decorations render.
 *
 * Selection highlighting is automatic — Decoration.mark text is real text,
 * so CM6 selection paints through it naturally (no .cm-pill-selected needed).
 *
 * AI change styling (cm-ref-ai-insertion / cm-ref-ai-deletion) when a
 * link falls inside a diff hunk's insertion or deletion region.
 *
 * Also exports a click handler factory for reference → document navigation.
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
import { type PillAIChangeType, RefIconWidget } from "./WikiLinkWidget";
import { findWikiLinks } from "./wikiLinkRegex";
import {
  buildMeridianClipboardFromWikiText,
  meridianPayloadToWikiLinkText,
} from "./clipboardInterop";
import { resolveDocumentByPath } from "./resolveDocument";
import {
  extractHunks,
  hasAnyMarker,
  type MergedHunk,
} from "@/core/lib/mergedDocument";

// =============================================================================
// AI CHANGE DETECTION
// =============================================================================

/**
 * Determine if a wiki-link falls within an AI diff hunk's insertion or
 * deletion region. Returns "none" if the link doesn't overlap any hunk.
 *
 * Marker positions in a hunk: DEL_START delText DEL_END INS_START insText INS_END
 * - Deletion content: (delStart+1) .. delEnd  (exclusive of markers)
 * - Insertion content: (insStart+1) .. insEnd
 */
function getAIChangeType(
  from: number,
  to: number,
  hunks: MergedHunk[],
): PillAIChangeType {
  for (const hunk of hunks) {
    // Link is inside the insertion region (between INS_START marker and INS_END marker)
    if (from > hunk.insStart && to <= hunk.insEnd) return "insertion";
    // Link is inside the deletion region (between DEL_START marker and DEL_END marker)
    if (from > hunk.delStart && to <= hunk.delEnd) return "deletion";
  }
  return "none";
}

// =============================================================================
// VIEW PLUGIN
// =============================================================================

/**
 * Build decorations for all wiki-links in visible ranges.
 * Uses the mark-based pattern: hide syntax, style text, add icon widget.
 * Skips decoration when cursor is inside the link (reveals raw syntax).
 */
function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];
  const { selection } = view.state;
  const cursor = selection.main.head;

  // Only compute hunks when the document contains PUA diff markers
  const docText = view.state.doc.toString();
  const hunks = hasAnyMarker(docText) ? extractHunks(docText) : [];

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const links = findWikiLinks(text, from);

    for (const link of links) {
      // Obsidian-style: if cursor is collapsed inside this link, skip
      // decoration so user sees raw [[...]] syntax and can edit it.
      // Only when collapsed — a selection dragged through should keep the pill.
      if (selection.main.empty && cursor >= link.from && cursor < link.to) {
        continue;
      }

      const resolvedDoc = resolveDocumentByPath(link.path);
      const isBroken = resolvedDoc === null;

      const aiChangeType = getAIChangeType(link.from, link.to, hunks);

      // Build mark class based on state
      const markClasses = ["cm-inline-ref"];
      if (isBroken) markClasses.push("cm-inline-ref-broken");
      if (aiChangeType === "insertion") markClasses.push("cm-ref-ai-insertion");
      if (aiChangeType === "deletion") markClasses.push("cm-ref-ai-deletion");

      // Data attributes for click handler and tooltip
      const attributes: Record<string, string> = {
        "data-doc-path": link.path,
        "data-display-name": link.displayName,
        title: isBroken ? `Document not found: ${link.path}` : link.path,
      };
      if (resolvedDoc) {
        attributes["data-doc-id"] = resolvedDoc.id;
      }

      // 1. Replace opening syntax with icon widget (merging replace + widget
      //    into one Decoration.replace avoids CM6 breaking text flow when a
      //    point widget sits at the same position as a mark decoration start).
      decorations.push({
        from: link.from,
        to: link.displayFrom,
        deco: Decoration.replace({
          widget: new RefIconWidget(isBroken),
        }),
      });

      // 2. Mark decoration on display text
      decorations.push({
        from: link.displayFrom,
        to: link.displayTo,
        deco: Decoration.mark({
          class: markClasses.join(" "),
          attributes,
        }),
      });

      // 3. Hide closing syntax: from display text end to ]]
      decorations.push({
        from: link.displayTo,
        to: link.to,
        deco: Decoration.replace({}),
      });
    }
  }

  // Decorations must be sorted by position
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decorations.map((d) => d.deco.range(d.from, d.to)));
}

const wikiLinkViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private view: EditorView;
    private pendingRebuild = false;
    private onPointerUp: () => void;

    constructor(view: EditorView) {
      this.view = view;
      this.decorations = buildDecorations(view);

      // Listen on document so we catch releases outside the editor
      this.onPointerUp = () => {
        if (this.pendingRebuild) {
          this.pendingRebuild = false;
          setTimeout(() => this.view.dispatch({}), 0);
        }
      };
      document.addEventListener("pointerup", this.onPointerUp);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
        return;
      }

      if (update.selectionSet) {
        // Pointer-driven selection (drag-select): defer rebuild to avoid
        // flicker when decorations toggle mid-drag (known CM6 issue).
        const isPointer = update.transactions.some((tr) =>
          tr.isUserEvent("select.pointer"),
        );
        if (isPointer) {
          this.pendingRebuild = true;
          return;
        }

        // Keyboard navigation — rebuild immediately
        this.decorations = buildDecorations(update.view);
      }
    }

    destroy() {
      document.removeEventListener("pointerup", this.onPointerUp);
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Create the wiki-link ViewPlugin extension.
 * Scans for [[...]] patterns and renders them as styled inline text.
 */
export function createWikiLinkPlugin(): Extension {
  return wikiLinkViewPlugin;
}

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
      // Walk up to find the inline ref element (click may land on icon or text)
      const ref = target.closest<HTMLElement>(".cm-inline-ref[data-doc-path]");
      if (!ref) return false;

      const docPath = ref.dataset.docPath;
      const docId = ref.dataset.docId;

      // Navigate if link is resolved (has docId)
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
