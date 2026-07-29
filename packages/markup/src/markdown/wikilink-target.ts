/** Validation and canonical target extraction for wikilink-valued hrefs. */

export function wikilinkTarget(href: string): string | null {
  if (!href.startsWith("[[") || !href.endsWith("]]")) return null;
  const target = href.slice(2, -2).trim();
  return target.length > 0 && !/[\r\n\]|]/.test(target) ? target : null;
}
