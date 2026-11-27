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

export interface CopiedDocument {
  documentId: string;
  uri: string;
}

export interface CopiedFolder {
  folderId: string;
  uri: string;
}

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
  sourceHolderUri: string | null;
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
    const parsed = parseLinkRef(identity);
    if (parsed?.kind === "doc") {
      const target = map.documents.get(parsed.documentId);
      return target ? documentAttrs(target, suffix, attrs.title) : null;
    }
    if (parsed?.kind === "folder" && occurrence.kind === "link") {
      const target = map.folders.get(parsed.folderId);
      return target ? folderAttrs(target, suffix, attrs.title) : null;
    }
    if (parsed?.kind === "ahead") {
      const settled = aheadSettlements?.get(identity);
      const target = settled ? map.documents.get(settled) : undefined;
      if (target) return documentAttrs(target, suffix, attrs.title);
      // An ahead ref settles only on a document. A folder may have arrived at its address
      // since it was minted (a writer links a folder before creating it), and the copy of
      // that folder is what the link now names.
      const address =
        occurrence.kind === "link" ? resolveDocumentHref(attrs.href, sourceHolderUri) : null;
      const folder = address ? map.foldersAt.get(address.uri) : undefined;
      return folder ? folderAttrs(folder, suffix, attrs.title) : null;
    }
    return null;
  }
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
