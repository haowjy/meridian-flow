/**
 * Public entry `@meridian/markup/stored-links`: the keys a host must load before spelling stored
 * link, image and figure destinations (every adapter's `prepare`).
 */
import { parseLinkRef, resolveStoredLinkAddress } from "@meridian/contracts";
import type { Node as PMNode } from "prosemirror-model";

import { walkLinkOccurrences } from "./link-occurrences.js";

export interface StoredLinkOccurrence {
  kind: "link" | "image" | "figure";
  ref: string | null;
  /** Stored `href`, or an image/figure `src`. */
  href: string;
}

/** What spelling stored occurrences needs loaded: refs, address-bound targets and `asset:` ids. */
export interface StoredLinkKeys {
  refs: Set<string>;
  /** Decoded addresses of stored ahead refs (an arrival there settles them). */
  aheadAddresses: Set<string>;
  /** Decoded addresses of ref-less directory hrefs, which resolve live or gone. */
  folderAddresses: Set<string>;
  assetIds: Set<string>;
}

export function storedLinkKeys(input: {
  /** Nodes that already carry stored attrs, such as copies. */
  nodes?: readonly PMNode[];
  /** Identities to load besides the stored ones, such as shown facts' (an `asset:` one loads its id). */
  refs?: readonly string[];
  /** URI of the document holding `nodes`; required by relative directory hrefs. */
  holderUri: string | null;
}): StoredLinkKeys {
  const keys: StoredLinkKeys = {
    refs: new Set(),
    aheadAddresses: new Set(),
    folderAddresses: new Set(),
    assetIds: new Set(),
  };
  for (const ref of input.refs ?? []) {
    if (ref.startsWith("asset:")) keys.assetIds.add(ref.slice("asset:".length));
    else keys.refs.add(ref);
  }
  for (const { kind, attrs } of walkLinkOccurrences(input.nodes ?? [])) {
    const { ref, href } = attrs;
    if (ref) {
      keys.refs.add(ref);
      if (parseLinkRef(ref)?.kind === "ahead") {
        const stored = resolveStoredLinkAddress({ href }, input.holderUri);
        if (stored?.kind === "document") keys.aheadAddresses.add(stored.uri);
      }
    } else if (kind === "link") {
      const stored = resolveStoredLinkAddress({ href }, input.holderUri);
      if (stored?.kind === "folder") keys.folderAddresses.add(stored.uri);
    } else if (href.startsWith("asset:")) {
      keys.assetIds.add(href.slice("asset:".length));
    }
  }
  return keys;
}
