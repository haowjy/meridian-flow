/**
 * Link Renderer
 *
 * SOLID: Single Responsibility - Handles markdown links [text](url)
 *
 * Classifies links and creates appropriate decorations:
 * - Internal links (relative paths): 3-part pill decoration (same as wiki-links)
 * - External links (URLs): Mark with data-url for click handler
 * - Anchors (#fragment): Simple mark styling
 * - Unsupported (absolute paths, query strings): Simple mark styling
 */

import { Decoration, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { NodeRenderer, DecorationRange, RenderContext } from "../types";
import { cursorInSameWord, cursorAdjacentToRange } from "../cursorUtils";
import { classifyLinkTarget } from "@/core/references";
import type { ResolvedRef } from "@/core/references";
import { PILL_MARK_CLASS, PILL_FOLDER_CLASS } from "@/shared/reference-pill/constants";

// ============================================================================
// DECORATIONS
// ============================================================================

/**
 * Basic link styling (for external, anchor, and unsupported types)
 */
const linkMark = Decoration.mark({ class: "cm-link" });

// ============================================================================
// RENDERER
// ============================================================================

export const linkRenderer: NodeRenderer = {
  nodeTypes: ["Link"],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = [];
    const { state, cursorWords } = ctx;
    const from = node.from;
    const to = node.to;

    // If cursor is in same word or adjacent to the link, show all syntax.
    // Adjacent check catches clicks on pills (which land cursor at edge).
    if (
      cursorInSameWord(cursorWords, from, to) ||
      cursorAdjacentToRange(state, from, to)
    ) {
      return decorations;
    }

    const text = state.doc.sliceString(from, to);
    const closeBracketIdx = text.indexOf("](");

    if (closeBracketIdx === -1) {
      return decorations;
    }

    // Extract link text and URL
    const linkText = text.slice(1, closeBracketIdx); // Skip opening [
    const urlStart = closeBracketIdx + 2;
    const urlEnd = text.length - 1; // Exclude closing )
    const url = text.slice(urlStart, urlEnd);

    // Calculate positions
    const textStart = from + 1;
    const textEnd = from + closeBracketIdx;
    const urlPartStart = from + closeBracketIdx;
    const urlPartEnd = to;

    // Classify the link target
    const classification = classifyLinkTarget(url);

    switch (classification.type) {
      case "internal":
        // Internal link: use pill decoration pattern (same as wiki-links)
        return renderInternalLink(
          decorations,
          from,
          to,
          textStart,
          textEnd,
          urlPartStart,
          urlPartEnd,
          classification.normalizedPath,
          linkText,
          classification.resolved,
        );

      case "external":
        // External link: render as real <a> element (widget)
        return renderExternalLink(
          decorations,
          from,
          to,
          linkText,
          url,
        );

      case "anchor":
      case "unsupported":
      default:
        // Simple link styling (no special handling)
        return renderSimpleLink(
          decorations,
          from,
          textStart,
          textEnd,
          urlPartStart,
          urlPartEnd,
        );
    }
  },
};

// ============================================================================
// RENDER HELPERS
// ============================================================================

/**
 * Render an internal link as a pill (same pattern as wiki-links).
 * Uses 3-part decoration: hide opening [, mark text with pill class, hide ](url)
 *
 * Note: Internal links are never "broken" — if the path doesn't resolve,
 * classifyLinkTarget returns "external" instead.
 */
function renderInternalLink(
  decorations: DecorationRange[],
  from: number,
  to: number,
  textStart: number,
  textEnd: number,
  urlPartStart: number,
  urlPartEnd: number,
  normalizedPath: string,
  displayName: string,
  resolved: ResolvedRef,
): DecorationRange[] {
  const isFolder = resolved.type === "folder";

  // Build mark class based on state
  const markClasses = [PILL_MARK_CLASS];
  if (isFolder) markClasses.push(PILL_FOLDER_CLASS);

  // Data attributes for click handler, tooltip, and X-to-delete
  const attributes: Record<string, string> = {
    "data-doc-path": normalizedPath,
    "data-display-name": displayName,
    // Full link range for X-to-delete (icon area click)
    "data-link-from": String(from),
    "data-link-to": String(to),
    "data-ref-id": resolved.id,
    "data-ref-type": resolved.type,
    title: normalizedPath,
  };
  // Keep data-doc-id for backward compat with clipboard interop
  if (!isFolder) {
    attributes["data-doc-id"] = resolved.id;
  }

  // 1. Hide opening [
  decorations.push({
    from,
    to: from + 1,
    deco: Decoration.replace({}),
  });

  // 2. Mark text with pill class + attributes
  if (textEnd > textStart) {
    decorations.push({
      from: textStart,
      to: textEnd,
      deco: Decoration.mark({
        class: markClasses.join(" "),
        attributes,
      }),
    });
  }

  // 3. Hide ](url)
  decorations.push({
    from: urlPartStart,
    to: urlPartEnd,
    deco: Decoration.replace({}),
  });

  return decorations;
}

/**
 * Widget that renders an external link as a real <a> element.
 * Benefits: right-click works, middle-click opens in new tab, accessible to screen readers.
 */
class ExternalLinkWidget extends WidgetType {
  constructor(
    private text: string,
    private href: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const a = document.createElement("a");
    a.href = this.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "cm-link";
    a.textContent = this.text;
    return a;
  }

  eq(other: ExternalLinkWidget): boolean {
    return this.text === other.text && this.href === other.href;
  }
}

/**
 * Render an external link as a real <a> element using a widget.
 * Replaces entire [text](url) with a single anchor element.
 */
function renderExternalLink(
  decorations: DecorationRange[],
  from: number,
  to: number,
  linkText: string,
  url: string,
): DecorationRange[] {
  // Prepend https:// for bare domains (e.g., "google.com" → "https://google.com")
  const href = url.includes("://") ? url : `https://${url}`;

  // Replace entire [text](url) with a widget containing a real <a> element
  decorations.push({
    from,
    to,
    deco: Decoration.replace({
      widget: new ExternalLinkWidget(linkText, href),
    }),
  });

  return decorations;
}

/**
 * Render a simple link (anchor or unsupported) with basic styling.
 */
function renderSimpleLink(
  decorations: DecorationRange[],
  from: number,
  textStart: number,
  textEnd: number,
  urlPartStart: number,
  urlPartEnd: number,
): DecorationRange[] {
  // Hide the opening [
  decorations.push({
    from,
    to: from + 1,
    deco: Decoration.replace({}),
  });

  // Style the link text
  if (textEnd > textStart) {
    decorations.push({
      from: textStart,
      to: textEnd,
      deco: linkMark,
    });
  }

  // Hide ](url)
  decorations.push({
    from: urlPartStart,
    to: urlPartEnd,
    deco: Decoration.replace({}),
  });

  return decorations;
}
