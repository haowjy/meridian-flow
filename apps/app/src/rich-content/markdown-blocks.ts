/** Conservative render units, with fence boundaries relative to their Markdown containers. */
type Container = { kind: "quote" } | { kind: "indent"; width: number };
type Fence = { marker: string; length: number; containers: Container[] };

/** Tabs are indentation columns, not single spaces (CommonMark tab stops are four columns). */
function indentationColumns(line: string): string {
  if (!line.includes("\t")) return line;
  let column = 0;
  return line.replace(/[^\t]|\t/g, (char) => {
    const width = char === "\t" ? 4 - (column % 4) : 1;
    column += width;
    return char === "\t" ? " ".repeat(width) : char;
  });
}

function stripContainers(line: string, containers: readonly Container[]): string | null {
  for (const container of containers) {
    if (container.kind === "quote") {
      const prefix = /^ {0,3}> ?/.exec(line);
      if (!prefix) return null;
      line = line.slice(prefix[0].length);
    } else {
      if (!line.trim()) return "";
      if (!line.startsWith(" ".repeat(container.width))) return null;
      line = line.slice(container.width);
    }
  }
  return line;
}

export function splitMarkdownBlocks(source: string): { blocks: string[]; openFence: boolean } {
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let blank = false;
  let container = false;
  const containers: Container[] = [];
  let fence: Fence | null = null;
  // Definitions can change earlier inline syntax; HTML can own blank lines.
  let wholeDocument = false;
  for (const line of source.split(/(?<=\n)/)) {
    const text = indentationColumns(line.replace(/\r?\n$/, ""));
    const empty = /^\s*$/.test(text);
    const listOrQuote = /^ {0,3}(?:>|[-+*](?:\s|$)|\d+[.)](?:\s|$))/.test(text);
    const indented = /^ {2,}/.test(text);
    if (fence) {
      const content = stripContainers(text, fence.containers);
      // A fence cannot continue outside its quote/list; its container ended.
      if (content === null) fence = null;
      else {
        const closer = /^ {0,3}(`{3,}|~{3,}) *$/.exec(content);
        if (closer && closer[1][0] === fence.marker && closer[1].length >= fence.length) {
          fence = null;
        }
        blank = empty;
        offset += line.length;
        continue;
      }
    }
    if (
      blank &&
      !empty &&
      !wholeDocument &&
      source.slice(start, offset).trim() &&
      !(container && (listOrQuote || indented))
    ) {
      blocks.push(source.slice(start, offset));
      start = offset;
      container = false;
    }
    let content = stripContainers(text, containers);
    while (content === null) {
      containers.pop();
      content = stripContainers(text, containers);
    }
    // List markers become indentation on continuation lines. Quote markers
    // remain explicit. Keeping the ordered prefix also handles lists in quotes.
    while (true) {
      const quote = /^ {0,3}> ?/.exec(content);
      if (quote) {
        containers.push({ kind: "quote" });
        content = content.slice(quote[0].length);
        continue;
      }
      const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])( +|$)/.exec(content);
      if (!list) break;
      // Five or more spaces start indented code, not a nested fence.
      const padding = list[1].length;
      const width = list[0].length - padding + (padding > 4 ? 1 : padding || 1);
      containers.push({ kind: "indent", width });
      content = content.slice(width);
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = { marker: marker[1][0], length: marker[1].length, containers: [...containers] };
    } else if (/^ {0,3}\[(?:[^\]\\]|\\.)+\]:/.test(content) || /^\s*</.test(content)) {
      wholeDocument = true;
    }
    if (!empty) container ||= listOrQuote || indented;
    blank = empty;
    offset += line.length;
  }
  blocks.push(source.slice(start));
  return { blocks: wholeDocument ? [source] : blocks, openFence: fence !== null };
}
