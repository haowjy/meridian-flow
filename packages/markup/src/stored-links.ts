import { parseLinkRef, resolveStoredLinkAddress } from "@meridian/contracts";
import type { Node as PMNode } from "prosemirror-model";

import { walkLinkOccurrences } from "./link-occurrences.js";

export interface StoredLinkOccurrence {
  kind: "link" | "image" | "figure";
  ref: string | null;
  href: string;
}

export interface StoredLinkKeys {
  refs: Set<string>;
  aheadAddresses: Set<string>;
  folderAddresses: Set<string>;
  assetIds: Set<string>;
}

export function storedLinkKeys(input: {
  nodes?: readonly PMNode[];
  refs?: readonly string[];
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
