/**
 * The one copy remap (D24, 2c): a stored document's blocks become a new document's
 * content, with every link inside the copied set pointed at its copy and every other
 * link left naming what it named.
 *
 * Stored hrefs are absolute addresses (`storedHref` spells them with no holder), so a
 * relative spelling never leaks past the write that stored it. Copy therefore rewrites
 * only identities it actually copies: a `doc:`/`folder:` ref, an upload's `asset:` src,
 * or — for legacy and address-only spellings — the address the occurrence resolves to
 * from the *source* holder. A ref-less link that resolves to a copied identity becomes
 * that copy; one that resolves elsewhere is written absolute and keeps its target, so
 * relocation cannot retarget it. External and contextual hrefs stay as written.
 */
import { type OccurrenceAttrs, rebuildOccurrences } from "@meridian/agent-edit/integration";
import {
  documentRef,
  folderRef,
  parseLinkRef,
  resolveDocumentHref,
  splitDocumentHrefSuffix,
  storedHref,
} from "@meridian/contracts";
import type { PMNode } from "@meridian/markup";
import { occurrenceIdentity, walkLinkOccurrences } from "@meridian/markup/links";

/** One copied document's new identity and where it lands. */
export interface CopiedDocument {
  documentId: string;
  uri: string;
}

/** One copied folder's new identity and where it lands. */
export interface CopiedFolder {
  folderId: string;
  uri: string;
}

/**
 * The identities one copy creates, indexed by both the source identity and — for a
 * ref-less spelling that only names an address — the source address.
 */
export interface CopyIdentityMap {
  documents: ReadonlyMap<string, CopiedDocument>;
  folders: ReadonlyMap<string, CopiedFolder>;
  documentsAt: ReadonlyMap<string, CopiedDocument>;
  foldersAt: ReadonlyMap<string, CopiedFolder>;
}

const ASSET_PREFIX = "asset:";

export function createCopyIdentityMap(input: {
  documents: readonly (CopiedDocument & { sourceDocumentId: string; sourceUri: string })[];
  folders: readonly (CopiedFolder & { sourceFolderId: string; sourceUri: string })[];
}): CopyIdentityMap {
  return {
    documents: indexOnce(
      input.documents,
      (entry) => entry.sourceDocumentId,
      ({ sourceDocumentId, sourceUri, ...target }) => target,
    ),
    folders: indexOnce(
      input.folders,
      (entry) => entry.sourceFolderId,
      ({ sourceFolderId, sourceUri, ...target }) => target,
    ),
    documentsAt: indexOnce(
      input.documents,
      (entry) => entry.sourceUri,
      ({ sourceDocumentId, sourceUri, ...target }) => target,
    ),
    foldersAt: indexOnce(
      input.folders,
      (entry) => entry.sourceUri,
      ({ sourceFolderId, sourceUri, ...target }) => target,
    ),
  };
}

/**
 * A source maps to exactly one copy. Two targets for one source (a nested selection copied
 * twice) would let the last win and send the copied set's internal links outside it, so
 * the caller must collapse the selection first.
 */
function indexOnce<Entry, Target>(
  entries: readonly Entry[],
  key: (entry: Entry) => string,
  target: (entry: Entry) => Target,
): Map<string, Target> {
  const indexed = new Map<string, Target>();
  for (const entry of entries) {
    const source = key(entry);
    if (indexed.has(source)) throw new Error(`A copy maps ${source} to more than one target`);
    indexed.set(source, target(entry));
  }
  return indexed;
}

export function remapCopiedBlocks(input: {
  blocks: readonly PMNode[];
  map: CopyIdentityMap;
  /** The source holder's address: a stored relative spelling was written against it. */
  sourceHolderUri: string | null;
  /** Where each `ahead:` ref settles now, so a settled ref maps like a `doc:` one. */
  aheadSettlements?: ReadonlyMap<string, string>;
}): PMNode[] {
  const occurrences = walkLinkOccurrences(input.blocks);
  const attrs = occurrences.map((occurrence) =>
    remappedAttrs(occurrence, input.map, input.sourceHolderUri, input.aheadSettlements),
  );
  return rebuildOccurrences(input.blocks, occurrences, attrs);
}

function remappedAttrs(
  occurrence: ReturnType<typeof walkLinkOccurrences>[number],
  map: CopyIdentityMap,
  sourceHolderUri: string | null,
  aheadSettlements: ReadonlyMap<string, string> | undefined,
): OccurrenceAttrs | null {
  const { attrs } = occurrence;
  const suffix = splitDocumentHrefSuffix(attrs.href).suffix;
  const identity = occurrenceIdentity(occurrence);

  if (identity?.startsWith(ASSET_PREFIX)) {
    const target = map.documents.get(identity.slice(ASSET_PREFIX.length));
    return target
      ? { ref: null, href: `${ASSET_PREFIX}${target.documentId}`, title: attrs.title }
      : null;
  }
  if (identity !== null) {
    // A stored identity: the ref names the copy set exactly, whatever its href spells.
    const parsed = parseLinkRef(identity);
    if (parsed?.kind === "doc") {
      const target = map.documents.get(parsed.documentId);
      return target ? documentAttrs(target, suffix, attrs.title) : null;
    }
    if (parsed?.kind === "folder" && occurrence.kind === "link") {
      const target = map.folders.get(parsed.folderId);
      return target ? folderAttrs(target, suffix, attrs.title) : null;
    }
    // A ref minted before its target existed names that target once it arrives; the copy's
    // own read resolved the settlement, so it can point at the copy like any other ref.
    if (parsed?.kind === "ahead") {
      const settled = aheadSettlements?.get(identity);
      const target = settled ? map.documents.get(settled) : undefined;
      return target ? documentAttrs(target, suffix, attrs.title) : null;
    }
    return null;
  }
  // No identity: a picture's source spells under the manuscript root, which a copy
  // keeps, so only links are re-read from the source holder.
  if (occurrence.kind !== "link") return null;
  const address = resolveDocumentHref(attrs.href, sourceHolderUri);
  if (!address) return null;
  if (address.kind === "folder") {
    const target = map.foldersAt.get(address.uri);
    return target
      ? folderAttrs(target, address.suffix, attrs.title)
      : { ref: null, href: storedHref(address, address.suffix), title: attrs.title };
  }
  const target = map.documentsAt.get(address.uri);
  return target
    ? documentAttrs(target, address.suffix, attrs.title)
    : { ref: null, href: storedHref(address, address.suffix), title: attrs.title };
}

function documentAttrs(
  target: CopiedDocument,
  suffix: string,
  title: string | null,
): OccurrenceAttrs {
  return {
    ref: documentRef(target.documentId),
    href: storedHref({ kind: "document", uri: target.uri }, suffix),
    title,
  };
}

function folderAttrs(target: CopiedFolder, suffix: string, title: string | null): OccurrenceAttrs {
  return {
    ref: folderRef(target.folderId),
    href: storedHref({ kind: "folder", uri: target.uri }, suffix),
    title,
  };
}
