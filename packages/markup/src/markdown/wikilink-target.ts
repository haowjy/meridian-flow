/** Destination-only href decoding and lossless wikilink wire spelling. */

export function wikilinkTarget(href: string): string | null {
  if (!href.startsWith("[[") || !href.endsWith("]]")) return null;
  const raw = href.slice(2, -2);
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === "\\" && /[\\[\]|]/.test(raw[index + 1] ?? "")) index++;
    else if (/[\t\r\n[\]|]/.test(char ?? "")) return null;
  }
  const target = unescapeWikilinkText(raw).trim();
  return target || null;
}

export function unescapeWikilinkText(value: string): string {
  return value.replace(/\\([\\[\]|])/g, "$1");
}

/** Destination delimiters must never be mistaken for a display-text separator. */
export function formatWikilink(target: string, displayText = target): string {
  const destination = target.replace(/[\\[\]|]/g, "\\$&");
  return displayText === target
    ? `[[${destination}]]`
    : `[[${destination}|${displayText.replace(/[\\\]|]/g, "\\$&")}]]`;
}
