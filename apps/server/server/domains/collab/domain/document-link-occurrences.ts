/** Extract and rewrite stored href occurrences on a private Yjs document snapshot. */
import * as Y from "yjs";

type LinkAttributes = Record<string, unknown> & { href: string };
type DocumentLinkRun = {
  start: number;
  length: number;
  attributes: Record<string, unknown> & { link: LinkAttributes };
};
type DocumentLinkOccurrence =
  | {
      kind: "text";
      text: Y.XmlText;
      href: string;
      words: string;
      runs: DocumentLinkRun[];
    }
  | { kind: "image"; element: Y.XmlElement; href: string };

export type DocumentLinkSubstitution = {
  href: string;
  /** Both names must be supplied to opt into exact filename/stem relabeling. */
  oldFilename?: string;
  newFilename?: string;
};

/** Runs with one contiguous href form an occurrence, even across other marks. */
export function extractDocumentLinkOccurrences(fragment: Y.XmlFragment): DocumentLinkOccurrence[] {
  const occurrences: DocumentLinkOccurrence[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      let start = 0;
      let occurrence: Extract<DocumentLinkOccurrence, { kind: "text" }> | undefined;
      for (const op of node.toDelta()) {
        const length = typeof op.insert === "string" ? op.insert.length : 1;
        const link = op.attributes?.link;
        if (typeof op.insert === "string" && link && typeof link.href === "string") {
          if (!occurrence || occurrence.href !== link.href) {
            occurrence = { kind: "text", text: node, href: link.href, words: "", runs: [] };
            occurrences.push(occurrence);
          }
          occurrence.words += op.insert;
          occurrence.runs.push({ start, length, attributes: op.attributes });
        } else occurrence = undefined;
        start += length;
      }
      return;
    }
    if (node instanceof Y.XmlElement && (node.nodeName === "image" || node.nodeName === "figure")) {
      const src = node.getAttribute("src");
      if (typeof src === "string" && src)
        occurrences.push({ kind: "image", element: node, href: src });
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) walk(child);
    }
  };
  walk(fragment);
  return occurrences;
}

/**
 * Mutates only the supplied snapshot. Extract first so chains are simultaneous,
 * and edit back-to-front so a relabel cannot shift the next occurrence's runs.
 * The caller owns snapshot creation, admission, persistence, and publication.
 */
export function applyDocumentLinkSubstitutions(
  fragment: Y.XmlFragment,
  substitutions: ReadonlyMap<string, DocumentLinkSubstitution>,
): number {
  if (!fragment.doc) throw new Error("Link rewriting requires an integrated snapshot fragment");
  const occurrences = extractDocumentLinkOccurrences(fragment);
  let changed = 0;
  fragment.doc.transact(() => {
    for (const occurrence of occurrences.reverse()) {
      const substitution = substitutions.get(occurrence.href);
      if (!substitution) continue;
      if (occurrence.kind === "image") {
        if (occurrence.href === substitution.href) continue;
        occurrence.element.setAttribute("src", substitution.href);
      } else {
        const { text, runs, words } = occurrence;
        const first = runs[0];
        if (!first) continue;
        const { oldFilename, newFilename } = substitution;
        const label =
          oldFilename !== undefined && newFilename !== undefined && oldFilename !== newFilename
            ? words === oldFilename
              ? newFilename
              : words === stem(oldFilename)
                ? stem(newFilename)
                : null
            : null;
        // Clear before retargeting: format(newHref) alone leaves an old-href
        // restore before the end marker. A draft's ProseMirror edit can replace
        // that marker, exposing the restore on plain text after the next move.
        if (label !== null && label !== words) {
          // Insert inside the old run with its own marks, delete around it, then
          // retarget. This preserves concurrent hand retargets (L4's probe).
          text.insert(first.start + 1, label, first.attributes);
          text.delete(first.start, 1);
          text.delete(first.start + label.length, words.length - 1);
          text.format(first.start, label.length, { link: null });
          text.format(first.start, label.length, {
            link: { ...first.attributes.link, href: substitution.href },
          });
        } else {
          if (occurrence.href === substitution.href) continue;
          for (const run of runs) {
            text.format(run.start, run.length, { link: null });
            text.format(run.start, run.length, {
              link: { ...run.attributes.link, href: substitution.href },
            });
          }
        }
      }
      changed++;
    }
  });
  return changed;
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
