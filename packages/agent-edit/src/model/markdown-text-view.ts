// The writer's text inside serialized markdown, with offsets back into the markdown.
//
// The serializer escapes text that would otherwise parse as syntax: `LIVE_ONLY`
// becomes `LIVE\_ONLY` and a leading space becomes `&#x20;`. A model types the
// writer's words, or copies the escaped form from a `read`, so `find` and
// `search` compare both sides in this view. Each view character maps to the
// whole markdown unit it came from, so a match never splits an escape.

/** One left-to-right unit: a backslash escape, a numeric character reference, or a character with its combining marks. */
const UNIT =
  /\\[!-/:-@[-`{-~]|&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});|\P{Mark}\p{Mark}*|\p{Mark}+/gu;

export interface MarkdownTextView {
  /** The text the writer sees, NFC-normalized. */
  text: string;
  /** Markdown offset where the unit behind each `text` code unit starts. */
  start: number[];
  /** Markdown offset where the unit behind each `text` code unit ends. */
  end: number[];
}

export function markdownTextView(markdown: string): MarkdownTextView {
  const start: number[] = [];
  const end: number[] = [];
  let text = "";
  for (const match of markdown.matchAll(UNIT)) {
    const unit = match[0];
    const unitStart = match.index;
    const decoded = decodeUnit(unit, match[1], match[2]).normalize("NFC");
    text += decoded;
    for (let index = 0; index < decoded.length; index += 1) {
      start.push(unitStart);
      end.push(unitStart + unit.length);
    }
  }
  return { text, start, end };
}

/** The writer's text for a query, so escaped and unescaped queries compare alike. */
export function markdownPlainText(markdown: string): string {
  return markdownTextView(markdown).text;
}

function decodeUnit(unit: string, hex: string | undefined, decimal: string | undefined): string {
  if (unit.length === 2 && unit.startsWith("\\")) return unit.slice(1);
  const codePoint =
    hex !== undefined
      ? Number.parseInt(hex, 16)
      : decimal !== undefined
        ? Number.parseInt(decimal, 10)
        : null;
  if (codePoint === null) return unit;
  const valid =
    codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : unit;
}
