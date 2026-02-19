/**
 * Fenced Code Block Renderer
 *
 * SOLID: Single Responsibility - Only handles fenced code block formatting
 *
 * Behavior: Line-level decorations (no widget replacement — cursor stays native)
 * - Cursor OUTSIDE code block -> hide fence markers, show language label,
 *   apply Shiki syntax colors via mark decorations
 * - Cursor INSIDE code block -> show raw markdown with line-level styling
 *
 * Why not widget replacement: CM6 block replacement decorations prevent
 * default cursor motion and cause interaction bugs around triple-backtick editing.
 * Line decorations let the editor handle all cursor/click behavior natively.
 */

import { Decoration } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { NodeRenderer, DecorationRange, RenderContext } from "../types";
import { selectionOverlapsRange } from "../cursorUtils";
import { tokenizeCode } from "../shikiHighlighter";

// ============================================================================
// LINE DECORATIONS
// ============================================================================

const codeBlockLineDeco = Decoration.line({ class: "cm-code-block" });
const codeBlockFirstLineDeco = Decoration.line({
  class: "cm-code-block cm-code-block-first",
});
const codeBlockLastLineDeco = Decoration.line({
  class: "cm-code-block cm-code-block-last",
});

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract language and code content from a FencedCode syntax tree node.
 * Uses sliceString per child to avoid O(doc) doc.toString().
 *
 * Lezer FencedCode structure:
 *   FencedCode
 *     CodeMark (```)
 *     CodeInfo? (language identifier)
 *     CodeText? (the actual code content)
 *     CodeMark (```)
 */
function extractCodeParts(
  node: SyntaxNode,
  state: { doc: { sliceString: (from: number, to: number) => string } },
): { language: string; code: string } {
  let language = "";
  let code = "";

  let child = node.firstChild;
  while (child) {
    if (child.name === "CodeInfo") {
      language = state.doc.sliceString(child.from, child.to).trim();
    } else if (child.name === "CodeText") {
      code = state.doc.sliceString(child.from, child.to);
      // Strip leading/trailing newlines that are part of the fence syntax
      if (code.startsWith("\n")) code = code.slice(1);
      if (code.endsWith("\n")) code = code.slice(0, -1);
    }
    child = child.nextSibling;
  }

  return { language, code };
}

/**
 * Build Shiki mark decorations for syntax highlighting on content lines.
 * Maps tokenizeCode() output to CM6 Decoration.mark() ranges.
 */
function buildShikiMarks(
  code: string,
  language: string,
  codeStartOffset: number,
): DecorationRange[] {
  const tokenLines = tokenizeCode(code, language);
  if (!tokenLines) return [];

  const marks: DecorationRange[] = [];
  const codeLines = code.split("\n");

  // Walk through each token line and map to document positions
  let lineOffset = codeStartOffset;
  for (let i = 0; i < tokenLines.length && i < codeLines.length; i++) {
    const tokensForLine = tokenLines[i];
    const codeLine = codeLines[i];
    if (!tokensForLine || codeLine === undefined) continue;

    let charOffset = 0;
    for (const token of tokensForLine) {
      if (token.style && token.content.length > 0) {
        const from = lineOffset + charOffset;
        const to = from + token.content.length;
        marks.push({
          from,
          to,
          deco: Decoration.mark({
            attributes: { style: token.style, class: "cm-shiki-token" },
          }),
        });
      }
      charOffset += token.content.length;
    }
    // +1 for the newline between lines
    lineOffset += codeLine.length + 1;
  }

  return marks;
}

// ============================================================================
// RENDERER
// ============================================================================

export const fencedCodeRenderer: NodeRenderer = {
  nodeTypes: ["FencedCode"],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = [];
    const { state } = ctx;
    const startLine = state.doc.lineAt(node.from);
    const endLine = state.doc.lineAt(node.to);

    // +1 padding matches other block renderers (heading, blockquote)
    // so cursor at the character after closing fence still shows raw
    if (selectionOverlapsRange(state, node.from, node.to + 1)) {
      // Cursor inside — show raw markdown with line styling on every line
      for (
        let lineNum = startLine.number;
        lineNum <= endLine.number;
        lineNum++
      ) {
        const line = state.doc.line(lineNum);
        decorations.push({ from: line.from, to: line.from, deco: codeBlockLineDeco });
      }
      return decorations;
    }

    // Cursor outside — hide fences, show language label, apply syntax colors

    // --- Opening fence line (```lang) ---
    decorations.push({
      from: startLine.from,
      to: startLine.from,
      deco: codeBlockFirstLineDeco,
    });
    // Hide the entire opening fence line content
    if (startLine.to > startLine.from) {
      decorations.push({
        from: startLine.from,
        to: startLine.to,
        deco: Decoration.replace({}),
      });
    }

    // --- Content lines (between fences) ---
    const { language, code } = extractCodeParts(node.node, state);

    // Find the CodeText node to get the exact code start offset for Shiki mapping
    let codeTextFrom = -1;
    let child = node.node.firstChild;
    while (child) {
      if (child.name === "CodeText") {
        codeTextFrom = child.from;
        // Skip leading newline that's part of fence syntax
        const firstChar = state.doc.sliceString(child.from, child.from + 1);
        if (firstChar === "\n") codeTextFrom = child.from + 1;
        break;
      }
      child = child.nextSibling;
    }

    // First content line gets data-lang attribute for CSS ::before label
    // (block widgets are not allowed from ViewPlugins, so we use a pseudo-element)
    const contentStart = startLine.number + 1;
    if (language && contentStart < endLine.number) {
      const firstContentLine = state.doc.line(contentStart);
      decorations.push({
        from: firstContentLine.from,
        to: firstContentLine.from,
        deco: Decoration.line({
          class: "cm-code-block",
          attributes: { "data-lang": language },
        }),
      });
    }

    // Remaining content lines get plain cm-code-block
    const loopStart = language ? contentStart + 1 : contentStart;
    for (let lineNum = loopStart; lineNum < endLine.number; lineNum++) {
      const line = state.doc.line(lineNum);
      decorations.push({ from: line.from, to: line.from, deco: codeBlockLineDeco });
    }

    // --- Shiki syntax highlighting marks ---
    if (language && code && codeTextFrom >= 0) {
      const shikiMarks = buildShikiMarks(code, language, codeTextFrom);
      decorations.push(...shikiMarks);
    }

    // --- Closing fence line (```) ---
    if (endLine.number > startLine.number) {
      decorations.push({
        from: endLine.from,
        to: endLine.from,
        deco: codeBlockLastLineDeco,
      });
      // Hide the entire closing fence line content
      if (endLine.to > endLine.from) {
        decorations.push({
          from: endLine.from,
          to: endLine.to,
          deco: Decoration.replace({}),
        });
      }
    }

    return decorations;
  },
};
