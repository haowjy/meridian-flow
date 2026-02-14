/**
 * Inline Code Renderer
 *
 * SOLID: Single Responsibility - Only handles inline code formatting
 *
 * Fenced code blocks are handled separately in fencedCode.ts
 */

import { Decoration } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { NodeRenderer, DecorationRange, RenderContext } from "../types";
import { cursorInSameWord } from "../cursorUtils";

// ============================================================================
// DECORATIONS
// ============================================================================

const inlineCodeMark = Decoration.mark({ class: "cm-inline-code" });

// ============================================================================
// INLINE CODE RENDERER
// ============================================================================

export const inlineCodeRenderer: NodeRenderer = {
  nodeTypes: ["InlineCode"],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = [];
    const { cursorWords } = ctx;
    const from = node.from;
    const to = node.to;

    // If cursor is in same word, show backticks but style content
    if (cursorInSameWord(cursorWords, from, to)) {
      if (to - from > 2) {
        decorations.push({
          from: from + 1,
          to: to - 1,
          deco: inlineCodeMark,
        });
      }
      return decorations;
    }

    // Hide the ` markers
    decorations.push({
      from,
      to: from + 1,
      deco: Decoration.replace({}),
    });
    decorations.push({
      from: to - 1,
      to,
      deco: Decoration.replace({}),
    });

    // Style the content
    if (to - from > 2) {
      decorations.push({
        from: from + 1,
        to: to - 1,
        deco: inlineCodeMark,
      });
    }

    return decorations;
  },
};
