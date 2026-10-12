/**
 * The `<br/>` tag a hard break escalates to where Markdown has no spelling.
 *
 * Between words a break is `\` and a newline. At the end of a paragraph that
 * `\` is a literal backslash, so the breaks ending a paragraph are written as
 * tags, the way a sized picture climbs to `<img>`. Pure Markdown hands the tag over
 * as `html` and MDX as a parsed JSX element; both read back as one break. A
 * paragraph holding only breaks is a lone line of `<br/>` tags, which both
 * dialects may read as blocks; the block chain wraps a lone break back into a
 * paragraph, and `joinBreakLines` regroups MDX's one element per tag.
 */

import type { MdastRoot } from "../../ast.js";
import type { BlockCodec, PMNode } from "../../types.js";
import { parseHtml } from "../html-tag.js";

export const HARD_BREAK_TAG = "<br/>";

export const hardBreakCodec: BlockCodec = {
  name: "hard_break",

  serialize() {
    return HARD_BREAK_TAG;
  },

  parse(ast, ctx): PMNode | null {
    return isBreakTag(ast) ? ctx.schema.node("hard_break") : null;
  },
};

/** One bare `<br>` tag: no attributes, no children, as `html` or as parsed JSX. */
function isBreakTag(ast: unknown): boolean {
  const record = typeof ast === "object" && ast !== null ? (ast as Record<string, unknown>) : null;
  if (record?.type === "html" && typeof record.value === "string") {
    const element = parseHtml(record.value.trim());
    return element?.name === "br" && element.attributes.size === 0;
  }
  if (record?.type !== "mdxJsxTextElement" && record?.type !== "mdxJsxFlowElement") return false;
  const empty = (value: unknown) => !Array.isArray(value) || value.length === 0;
  return record.name === "br" && empty(record.attributes) && empty(record.children);
}

type MdastParent = { children?: unknown[] };
type Positioned = { position?: { start?: { line?: number }; end?: { line?: number } } };

/**
 * MDX reads a line of `<br/>` tags as one flow element per tag, which would
 * come back as a paragraph each. Tags sharing a line are one paragraph of
 * breaks, so each such run is regrouped into a paragraph of inline tags.
 */
export function joinBreakLines(root: MdastRoot): MdastRoot {
  regroup(root as MdastParent);
  return root;
}

function regroup(parent: MdastParent): void {
  const children = parent.children;
  if (!Array.isArray(children)) return;
  const out: unknown[] = [];
  const joined = new Set<unknown>();
  for (const child of children) {
    const previous = out.at(-1) as (MdastParent & Positioned) | undefined;
    if (isFlowBreak(child) && previous && sameLine(previous, child as Positioned)) {
      if (joined.has(previous)) {
        previous.children?.push(asTextBreak(child));
        if (previous.position?.end) previous.position.end = (child as Positioned).position?.end;
        continue;
      }
      if (isFlowBreak(previous)) {
        const paragraph = {
          type: "paragraph",
          children: [asTextBreak(previous), asTextBreak(child)],
          position: {
            start: previous.position?.start,
            end: (child as Positioned).position?.end,
          },
        };
        joined.add(paragraph);
        out[out.length - 1] = paragraph;
        continue;
      }
    }
    regroup(child as MdastParent);
    out.push(child);
  }
  parent.children = out;
}

function isFlowBreak(node: unknown): boolean {
  const record = node as { type?: string; name?: string } | null;
  return record?.type === "mdxJsxFlowElement" && record.name === "br" && isBreakTag(node);
}

function asTextBreak(node: unknown): unknown {
  return { ...(node as object), type: "mdxJsxTextElement" };
}

function sameLine(left: Positioned, right: Positioned): boolean {
  const end = left.position?.end?.line;
  return end !== undefined && end === right.position?.start?.line;
}
