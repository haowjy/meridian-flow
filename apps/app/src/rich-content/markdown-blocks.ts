/** Conservative render units: only a blank line outside a fence can settle a tail. */
export function splitMarkdownBlocks(source: string): { blocks: string[]; openFence: boolean } {
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let blank = false;
  let container = false;
  let fence: { marker: string; length: number } | null = null;
  // Definitions can change earlier inline syntax; HTML can own blank lines.
  // Keep these uncommon documents together rather than guess at their grammar.
  let wholeDocument = false;
  for (const line of source.split(/(?<=\n)/)) {
    const text = line.replace(/\r?\n$/, "");
    const empty = /^\s*$/.test(text);
    const listOrQuote = /^ {0,3}(?:>|[-+*](?:\s|$)|\d+[.)](?:\s|$))/.test(text);
    const indented = /^(?: {2,}|\t)/.test(text);
    const marker = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/.exec(text);
    if (!fence && !marker && (/\[[^\]\n]+\](?!\()/.test(text) || /^\s*</.test(text))) {
      wholeDocument = true;
    }
    if (
      blank &&
      !empty &&
      !fence &&
      !wholeDocument &&
      source.slice(start, offset).trim() &&
      !(container && (listOrQuote || indented))
    ) {
      blocks.push(source.slice(start, offset));
      start = offset;
      container = false;
    }
    if (!empty) {
      container ||= listOrQuote || indented;
      if (marker) {
        const run = marker[1];
        const rest = marker[2];
        if (fence) {
          if (run[0] === fence.marker && run.length >= fence.length && /^\s*$/.test(rest)) {
            fence = null;
          }
        } else if (run[0] !== "`" || !rest.includes("`")) {
          fence = { marker: run[0], length: run.length };
        }
      }
    }
    blank = empty;
    offset += line.length;
  }
  blocks.push(source.slice(start));
  return { blocks: wholeDocument ? [source] : blocks, openFence: fence !== null };
}
