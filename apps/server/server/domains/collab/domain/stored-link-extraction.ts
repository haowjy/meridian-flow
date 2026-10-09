/**
 * Stored link, image and figure destinations of a live Yjs fragment, read
 * straight from the Yjs tree (never a ProseMirror projection) so the scope's
 * `prepare({ docs })`, the view-revision digest and derive stay cheap.
 */
import * as Y from "yjs";

export interface StoredLinkOccurrence {
  kind: "link" | "image" | "figure";
  ref: string | null;
  /** Stored `href`, or an image/figure `src`. */
  href: string;
}

/**
 * Document order. A link occurrence is a maximal run of text sharing one link
 * mark (href, title and ref), whatever other marks split it; a paragraph
 * boundary always ends a run.
 */
export function extractStoredLinks(fragment: Y.XmlFragment): StoredLinkOccurrence[] {
  const occurrences: StoredLinkOccurrence[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      let previous: Record<string, unknown> | undefined;
      for (const op of node.toDelta() as { insert: unknown; attributes?: { link?: unknown } }[]) {
        const link = op.attributes?.link as Record<string, unknown> | undefined;
        if (typeof op.insert !== "string" || !link || typeof link.href !== "string") {
          previous = undefined;
          continue;
        }
        if (!previous || !sameLinkMark(previous, link)) {
          occurrences.push({ kind: "link", ref: refOf(link.ref), href: link.href });
        }
        previous = link;
      }
      return;
    }
    if (node instanceof Y.XmlElement && (node.nodeName === "image" || node.nodeName === "figure")) {
      const src = node.getAttribute("src");
      if (typeof src === "string" && src) {
        occurrences.push({ kind: node.nodeName, ref: refOf(node.getAttribute("ref")), href: src });
      }
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) walk(child);
    }
  };
  walk(fragment);
  return occurrences;
}

function refOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function sameLinkMark(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return (
    a.href === b.href && (a.title ?? null) === (b.title ?? null) && refOf(a.ref) === refOf(b.ref)
  );
}
