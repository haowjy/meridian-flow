/**
 * Wiki-Link Inline Scanner
 *
 * InlineScanner implementation for `[[...]]` wiki-link patterns. Extracts
 * decoration logic from the old wikiLinkPlugin ViewPlugin so wiki-links
 * participate in the unified live preview rebuild schedule.
 *
 * Responsibilities:
 * - Find wiki-links via regex on the provided viewport text slice (O(viewport))
 * - Skip links that overlap excluded regions (diff hunks)
 * - Reveal raw syntax when cursor is collapsed inside a link
 * - Produce 3-part decorations: replace opening syntax (with icon widget),
 *   mark display text, replace closing syntax
 *
 * Interaction (click, clipboard) stays in wikiLinkPlugin.ts — this file is
 * purely decoration.
 */

import { Decoration } from "@codemirror/view";
import type {
  InlineScanner,
  RenderContext,
  DecorationRange,
} from "../livePreview/types";
import { overlapsExcludedRegion } from "../state/excludedRegions";
import { findWikiLinks } from "./wikiLinkRegex";
import { resolveDocumentByPath } from "./resolveDocument";

export const wikiLinkScanner: InlineScanner = {
  id: "wiki-links",

  scan(text: string, offset: number, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = [];
    const { state, excludedRegions } = ctx;
    const { selection } = state;
    const cursor = selection.main.head;
    const links = findWikiLinks(text, offset);

    for (const link of links) {
      // Skip wiki-links that overlap excluded regions (diff hunks)
      if (overlapsExcludedRegion(excludedRegions, link.from, link.to)) continue;

      // Obsidian-style: if cursor is collapsed inside this link, skip
      // decoration so user sees raw [[...]] syntax and can edit it.
      // Only when collapsed — a selection dragged through should keep the pill.
      if (selection.main.empty && cursor >= link.from && cursor < link.to) {
        continue;
      }

      const resolvedDoc = resolveDocumentByPath(link.path);
      const isBroken = resolvedDoc === null;

      // Build mark class based on state
      const markClasses = ["cm-inline-ref"];
      if (isBroken) markClasses.push("cm-inline-ref-broken");
      const title = isBroken
        ? `Document not found: ${link.path}`
        : link.path;

      // Data attributes for click handler and tooltip
      const attributes: Record<string, string> = {
        "data-doc-path": link.path,
        "data-display-name": link.displayName,
        title,
      };
      if (resolvedDoc) {
        attributes["data-doc-id"] = resolvedDoc.id;
      }

      // 1. Hide opening syntax ([[  or [[path|)
      decorations.push({
        from: link.from,
        to: link.displayFrom,
        deco: Decoration.replace({}),
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

    return decorations;
  },
};
