const UNIT =
  /\\[!-/:-@[-`{-~]|&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});|\P{Mark}\p{Mark}*|\p{Mark}+/gu;

interface MarkdownTextView {
  text: string;
  start: number[];
  end: number[];
}

export function markdownTextView(markdown: string): MarkdownTextView {
  const start: number[] = [];
  const end: number[] = [];
  let text = "";
  for (const { decoded, at, length } of units(markdown)) {
    text += decoded;
    for (let index = 0; index < decoded.length; index += 1) {
      start.push(at);
      end.push(at + length);
    }
  }
  return { text, start, end };
}

export function markdownPlainText(markdown: string): string {
  let text = "";
  for (const { decoded } of units(markdown)) text += decoded;
  return text;
}

function* units(markdown: string) {
  for (const match of markdown.matchAll(UNIT)) {
    const unit = match[0];
    yield {
      decoded: decodeUnit(unit, match[1], match[2]).normalize("NFC"),
      at: match.index,
      length: unit.length,
    };
  }
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
