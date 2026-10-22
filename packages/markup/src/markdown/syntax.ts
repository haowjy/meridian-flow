/** Concrete Markdown regions reported by the canonical micromark tokenizer. */

import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";

export interface MarkdownCodeRegion {
  from: number;
  to: number;
  fenced: boolean;
  closed: boolean;
}

export interface MarkdownSyntax {
  code: readonly MarkdownCodeRegion[];
}

export function markdownSyntax(source: string): MarkdownSyntax {
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(source, undefined, true)),
  );
  const fences = new Map<object, number>();
  const code: MarkdownCodeRegion[] = [];

  for (const [action, token] of events) {
    if (token.type === "codeFencedFence" && action === "enter") {
      for (let index = fences.size - 1; index >= 0; index--) {
        const region = code[index];
        if (region?.fenced && token.start.offset >= region.from && token.end.offset <= region.to) {
          fences.set(region, (fences.get(region) ?? 0) + 1);
          break;
        }
      }
      continue;
    }
    if (action !== "enter" || (token.type !== "codeFenced" && token.type !== "codeIndented")) {
      continue;
    }
    const region: MarkdownCodeRegion = {
      from: token.start.offset,
      to: token.end.offset,
      fenced: token.type === "codeFenced",
      closed: token.type === "codeIndented",
    };
    code.push(region);
    if (region.fenced) fences.set(region, 0);
  }

  for (const region of code) {
    if (region.fenced) region.closed = (fences.get(region) ?? 0) > 1;
  }
  return { code };
}
