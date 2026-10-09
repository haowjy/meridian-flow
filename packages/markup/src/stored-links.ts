/**
 * Public entry `@meridian/markup/stored-links`: stored link, image and figure destinations of a live Yjs fragment, read
 * straight from the Yjs tree (never a ProseMirror projection) so the scope's
 * `prepare({ docs })`, the view-revision digest and derive stay cheap; and the
 * keys a host must load before spelling them (every adapter's `prepare`).
 *
 * The Yjs twin of `walkLinkOccurrences`, which ref assignment and
 * shown facts walk: both must yield the same `(kind, ref, href)` sequence for
 * one document, or the note count and revision digest drift from what
 * assignment sees. agent-edit's `assign-refs.test.ts` pins that parity.
 */
import { resolveDocumentHref, storedLinkRef } from "@meridian/contracts";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema/protocol";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";

import { walkLinkOccurrences } from "./link-occurrences.js";

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
          occurrences.push({ kind: "link", ref: storedLinkRef(link.ref), href: link.href });
        }
        previous = link;
      }
      return;
    }
    if (node instanceof Y.XmlElement && (node.nodeName === "image" || node.nodeName === "figure")) {
      const src = node.getAttribute("src");
      if (typeof src === "string" && src) {
        occurrences.push({
          kind: node.nodeName,
          ref: storedLinkRef(node.getAttribute("ref")),
          href: src,
        });
      }
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) walk(child);
    }
  };
  walk(fragment);
  return occurrences;
}

function sameLinkMark(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return (
    a.href === b.href &&
    (a.title ?? null) === (b.title ?? null) &&
    storedLinkRef(a.ref) === storedLinkRef(b.ref)
  );
}

/** What spelling stored occurrences needs loaded: refs, ahead addresses and `asset:` ids. */
export interface StoredLinkKeys {
  refs: Set<string>;
  /** Decoded addresses of stored ahead refs (an arrival there settles them). */
  aheadAddresses: Set<string>;
  assetIds: Set<string>;
}

export function storedLinkKeys(input: {
  docs?: readonly Y.Doc[];
  /** Nodes that already carry stored attrs, such as copies. */
  nodes?: readonly PMNode[];
  refs?: readonly string[];
}): StoredLinkKeys {
  const keys: StoredLinkKeys = {
    refs: new Set(input.refs ?? []),
    aheadAddresses: new Set(),
    assetIds: new Set(),
  };
  const add = ({ kind, ref, href }: StoredLinkOccurrence) => {
    if (ref) {
      keys.refs.add(ref);
      if (ref.startsWith("ahead:")) {
        const stored = resolveDocumentHref(href, null);
        if (stored) keys.aheadAddresses.add(stored.uri);
      }
    } else if (kind !== "link" && href.startsWith("asset:")) {
      keys.assetIds.add(href.slice("asset:".length));
    }
  };
  for (const doc of input.docs ?? []) {
    for (const occurrence of extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)))
      add(occurrence);
  }
  for (const { kind, attrs } of walkLinkOccurrences(input.nodes ?? [])) {
    add({ kind, ref: attrs.ref, href: attrs.href });
  }
  return keys;
}
