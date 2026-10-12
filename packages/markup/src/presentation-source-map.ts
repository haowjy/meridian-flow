/** Opt-in parse provenance, projected onto final PM paths after text coalescing. */
import type { Node as PMNode } from "prosemirror-model";
import type { PresentationSourceRun, SourceRange } from "./types.js";

export type InlineOrigin = { node: PMNode; source: SourceRange | null; link: SourceRange | null };

type Positioned = { position?: { start?: { offset?: number }; end?: { offset?: number } } };
export function sourceRange(ast: unknown): SourceRange | null {
  const position = (ast as Positioned).position;
  const from = position?.start?.offset;
  const to = position?.end?.offset;
  return typeof from === "number" && typeof to === "number" ? { from, to } : null;
}

export function blockSourceMap(
  block: PMNode,
  blockIndex: number,
  origins: readonly InlineOrigin[],
  originalSource: boolean,
): PresentationSourceRun[] {
  originalSource &&= block.type.name !== "table";
  const runs: PresentationSourceRun[] = [];
  let cursor = 0;
  let valid = true;
  const visit = (node: PMNode, path: number[]) => {
    if (node.type.name === "code_block") return;
    if (!node.inlineContent) {
      node.forEach((child, _offset, index) => {
        visit(child, [...path, index]);
      });
      return;
    }
    let linkRun: PresentationSourceRun | undefined;
    let linkMark: PMNode["marks"][number] | undefined;
    node.forEach((child, _offset, index) => {
      const at = { block: blockIndex, path: [...path, index], count: 1 };
      const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined;
      if (!link || !linkMark?.eq(link)) linkRun = undefined;
      linkMark = link;
      if (!child.isText) return;
      let remaining = child.text?.length ?? 0;
      const parts: InlineOrigin[] = [];
      while (remaining > 0) {
        const origin = origins[cursor++];
        if (!origin) {
          valid = false;
          break;
        }
        parts.push(origin);
        remaining -= origin.node.text?.length ?? 0;
      }
      // Structural alignment only. No searching by label or rendered text.
      if (
        remaining !== 0 ||
        parts.map((part) => part.node.text).join("") !== child.text ||
        parts.some((part) => !PMNodeMarksEqual(part.node, child))
      )
        valid = false;
      // PM coalesces adjacent equally marked text. Keep the original runs as
      // subranges of that node, rather than granting authority across syntax gaps.
      let offset = 0;
      for (const part of parts) {
        runs.push({
          kind: "text",
          at: { ...at, offset },
          source: originalSource ? part.source : null,
        });
        offset += part.node.text?.length ?? 0;
      }
      if (!parts.length) runs.push({ kind: "text", at: { ...at, offset: 0 }, source: null });
      if (link) {
        const spans = parts.map((part) => part.link);
        const first = spans[0];
        const last = spans.at(-1);
        const source =
          originalSource && first && last && spans.every(Boolean)
            ? { from: first.from, to: last.to }
            : null;
        if (linkRun) {
          linkRun.at.count++;
          linkRun.source =
            linkRun.source && source ? { from: linkRun.source.from, to: source.to } : null;
        } else {
          linkRun = { kind: "link", at, source };
          runs.push(linkRun);
        }
      }
    });
  };
  visit(block, []);
  if (cursor !== origins.length) valid = false;
  if (!valid) for (const run of runs) run.source = null;
  return runs;
}

function PMNodeMarksEqual(a: PMNode, b: PMNode): boolean {
  return (
    a.marks.length === b.marks.length && a.marks.every((mark, index) => mark.eq(b.marks[index]))
  );
}
