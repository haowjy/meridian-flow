/** Ordered retained prose crossing paragraph boundaries, fenced by the caller's kept blocks. */
import { DIFF_DELETE, DIFF_EQUAL, makeDiff } from "@sanity/diff-match-patch";

type Token = { text: string | null; block: number };

export function retainedBlockRuns(before: readonly string[], after: readonly string[]) {
  const words = new Intl.Segmenter(undefined, { granularity: "word" });
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const tokenize = (blocks: readonly string[]): Token[] =>
    blocks.flatMap((text, block) => {
      const segments = [...words.segment(text)].map((part) => part.segment);
      const parts =
        segments.length === 1 ? [...graphemes.segment(text)].map((part) => part.segment) : segments;
      // Space and a paragraph break can replace each other without changing retained prose.
      return [
        ...(block > 0 ? [{ text: null, block }] : []),
        ...parts.filter((part) => !/^\s+$/u.test(part)).map((text) => ({ text, block })),
      ];
    });
  const old = tokenize(before),
    next = tokenize(after);
  const codes = new Map<string | null, string>();
  const encode = (tokens: Token[]) => {
    const offsets: number[] = [];
    const text = tokens
      .map((token, index) => {
        let code = codes.get(token.text);
        if (code === undefined) {
          const id = codes.size + 1;
          const value = id < 0xd800 ? id : id + 0x800;
          if (value > 0xffff) throw new RangeError("Too many distinct structural tokens");
          code = String.fromCharCode(value);
          codes.set(token.text, code);
        }
        // Weight retained words by prose length, not occurrence count. This avoids
        // trading a retained sentence for scattered repeated short tokens.
        const length = token.text?.length ?? 1;
        for (let count = 0; count < length; count++) offsets.push(index);
        return code.repeat(length);
      })
      .join("");
    return { text, offsets };
  };
  const a = encode(old),
    b = encode(next);
  const runs: { old: number[]; next: number[] }[] = [];
  let first: [number, number] | undefined, last: [number, number] | undefined;
  const flush = () => {
    if (first && last) {
      const source = old.slice(first[0], last[0] + 1);
      const target = next.slice(first[1], last[1] + 1);
      // A boundary strictly inside the retained run connects every block it touches.
      if ([...source, ...target].some((token) => token.text === null))
        runs.push({
          old: [...new Set(source.map((token) => token.block))],
          next: [...new Set(target.map((token) => token.block))],
        });
    }
    first = last = undefined;
  };
  let x = 0,
    y = 0,
    oldCursor = 0,
    nextCursor = 0;
  // Integrity cannot depend on a timed-out diff replacing the remaining gap wholesale.
  for (const [op, chunk] of makeDiff(a.text, b.text, { timeout: -1, checkLines: false })) {
    if (op === DIFF_EQUAL) {
      for (let index = 0; index < chunk.length; index++) {
        const source = a.offsets[x++],
          target = b.offsets[y++];
        if (source < oldCursor || target < nextCursor) continue;
        const removed = old.slice(oldCursor, source),
          added = next.slice(nextCursor, target);
        // One-sided insertion/deletion leaves a retained run on the other side.
        // Replacements interrupt both; matching paragraph boundaries fence runs.
        if (
          (removed.some((t) => t.text !== null) && added.some((t) => t.text !== null)) ||
          (removed.some((t) => t.text === null) && added.some((t) => t.text === null)) ||
          old[source].text === null
        )
          flush();
        if (old[source].text !== null) {
          first ??= [source, target];
          last = [source, target];
        }
        oldCursor = source + 1;
        nextCursor = target + 1;
      }
    } else if (op === DIFF_DELETE) x += chunk.length;
    else y += chunk.length;
  }
  flush();
  return runs;
}
