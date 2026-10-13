/** Whole-token differences shared by write lowering and identity-gap display. */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";

export interface WordHunk {
  from: number;
  to: number;
  text: string;
}

export function wordHunks(before: string, after: string): WordHunk[] {
  const tokens: string[] = [];
  const codes = new Map<string, string>();
  const encode = (text: string) =>
    (text.match(/[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu) ?? [])
      .map((token) => {
        let code = codes.get(token);
        if (code === undefined) {
          // One UTF-16 code unit per token, skipping surrogates. Fail rather than silently alias.
          const index = tokens.length + 1;
          const value = index < 0xd800 ? index : index + 0x800;
          if (value > 0xffff) throw new RangeError("Too many distinct word tokens");
          code = String.fromCharCode(value);
          codes.set(token, code);
          tokens.push(token);
        }
        return code;
      })
      .join("");
  const a = encode(before),
    b = encode(after);
  const decode = (encoded: string) =>
    encoded
      .split("")
      .map((code) => {
        const value = code.charCodeAt(0);
        return tokens[(value < 0xe000 ? value : value - 0x800) - 1];
      })
      .join("");
  const hunks: WordHunk[] = [];
  let offset = 0;
  let current: WordHunk | undefined;
  for (const [op, chunk] of makeDiff(a, b)) {
    const text = decode(chunk);
    if (op === DIFF_EQUAL) {
      if (current) hunks.push(current);
      current = undefined;
      offset += text.length;
    } else {
      current ??= { from: offset, to: offset, text: "" };
      if (op === DIFF_DELETE) {
        current.to += text.length;
        offset += text.length;
      }
      if (op === DIFF_INSERT) current.text += text;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}
