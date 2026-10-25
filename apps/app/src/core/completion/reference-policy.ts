/** Canonical reference identity and deterministic lexical ranking over catalog metadata. */
import {
  type CanonicalContextUri,
  type DocumentId,
  type FolderId,
  parseContextUri,
} from "@meridian/contracts";
import type {
  CatalogAuthorityEntry,
  CatalogFileEntry,
  CatalogFolderEntry,
  CatalogScope,
  DocumentFileType,
  Filetype,
} from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";
import type { StableReferenceAuthority } from "@meridian/thread-client";

export const REFERENCE_ROW_LIMIT = 20;
export const MAX_REFERENCE_QUERY_LENGTH = 80;

export type { StableReferenceAuthority };

export type DocumentReference = {
  kind: "document";
  documentId: DocumentId;
  uri: CanonicalContextUri;
  fileType: Filetype | DocumentFileType;
  authority: StableReferenceAuthority;
  label: string;
  /** A chat upload's intake identity: the proof a pre-creation pick carries into admission. */
  intake?: { intakeId: string; locationRevision: string };
};

/** A folder, named by its catalog entry; its URI is only where it is now. Area roots are never one. */
export type FolderReference = {
  kind: "folder";
  folderId: FolderId;
  uri: CanonicalContextUri;
  label: string;
};

/** What a terminal row names: a document or a folder. Each host inserts by `kind`. */
export type AuthoritativeReference = DocumentReference | FolderReference;

export type ReferenceNavigationAction = {
  type: "navigate";
  /** One authority segment or a full canonical source/folder prefix. */
  prefix: string;
  scope: CatalogScope;
  containerId?: string;
  /** Only authority activation crosses from warm metadata into scope acquisition. */
  acquire: boolean;
};

export type ReferenceSelectAction<Reference extends AuthoritativeReference = DocumentReference> = {
  type: "select";
  reference: Reference;
};

type NavigationRowBase = {
  rowId: string;
  label: string;
  location: string;
  matchAliases: readonly string[];
  action: ReferenceNavigationAction;
};

export type ReferenceRow =
  | (NavigationRowBase & { kind: "source" })
  | (NavigationRowBase & { kind: "authority"; authorityKind: "work" })
  | (NavigationRowBase & { kind: "folder" })
  | {
      kind: "file";
      rowId: string;
      label: string;
      location: string;
      fileKind: "document" | "asset";
      aliases: readonly string[];
      matchedAlias: string | null;
      action: ReferenceSelectAction;
    }
  /** The folder being listed, offered first under Back. Its label is the folder's name. */
  | {
      kind: "folder-mention";
      rowId: string;
      label: string;
      location: string;
      action: ReferenceSelectAction<FolderReference>;
    };

/** A row that names a reference rather than opening a level. */
export type ReferenceTerminalRow = Extract<ReferenceRow, { kind: "file" | "folder-mention" }>;

export type ReferenceAuthorityIndex = ReadonlyMap<string, CatalogAuthorityEntry>;

export type ReferenceRankingPriors = {
  openDocumentIds?: ReadonlySet<string>;
  contextualDocumentIds?: ReadonlySet<string>;
};

/** Folders are mentionable only where a host takes them; files are documents or assets. */
export type ReferenceKind = "document" | "asset" | "folder";

export type ReferencePolicyOptions = ReferenceRankingPriors & {
  kinds?: readonly ReferenceKind[];
};

type RankedRow = {
  row: ReferenceRow;
  tier: number;
  primary: number;
  open: number;
  contextual: number;
  order: number;
  matchedAlias: string | null;
};

/** Authority metadata is project-scope data. It never materializes a Work's files. */
export function referenceAuthorityIndex(
  entries: Iterable<CatalogAuthorityEntry>,
): ReferenceAuthorityIndex {
  return new Map([...entries].map((entry) => [authorityKey(entry.authority), entry]));
}

export function authoritativeReferenceForFile(
  entry: CatalogFileEntry,
  authorities: ReferenceAuthorityIndex,
): DocumentReference | null {
  const authority = stableAuthority(entry.scope, authorities, entry.uri);
  if (!authority) return null;
  const uri = referenceUriForAuthority(entry.uri, authority);
  if (!uri) return null;

  return {
    kind: "document",
    documentId: entry.entryId,
    uri,
    fileType: entry.editable ? entry.filetype : entry.fileType,
    authority,
    label: entry.name,
    ...(entry.upload
      ? {
          intake: {
            intakeId: entry.upload.intakeId,
            locationRevision: entry.upload.locationRevision,
          },
        }
      : {}),
  };
}

/**
 * A folder a writer can mention: one with a server identity (not device-synthesized
 * ancestry) whose address carries its stable authority. Area roots are sources, never folders.
 */
export function folderReferenceForEntry(
  entry: CatalogFolderEntry,
  authorities: ReferenceAuthorityIndex,
): FolderReference | null {
  if (entry.navigationOnly || entry.path.length === 0) return null;
  const uri = canonicalReferenceUri(entry.scope, entry.uri, authorities);
  return uri ? { kind: "folder", folderId: entry.entryId, uri, label: entry.name } : null;
}

/** The terminal browser row for a catalog file. */
export function referenceRowForFile(
  entry: CatalogFileEntry,
  authorities: ReferenceAuthorityIndex,
): Extract<ReferenceRow, { kind: "file" }> | null {
  const reference = authoritativeReferenceForFile(entry, authorities);
  if (!reference) return null;
  return {
    kind: "file",
    rowId: `file:${entry.entryId}`,
    label: entry.name,
    location: entry.path.slice(0, -1).join("/"),
    fileKind: entry.editable ? "document" : "asset",
    aliases: entry.aliases,
    matchedAlias: null,
    action: { type: "select", reference },
  };
}

/** The terminal browser row that names a folder rather than opening it. */
export function referenceRowForFolder(
  entry: CatalogFolderEntry,
  authorities: ReferenceAuthorityIndex,
): Extract<ReferenceRow, { kind: "folder-mention" }> | null {
  const reference = folderReferenceForEntry(entry, authorities);
  if (!reference) return null;
  return {
    kind: "folder-mention",
    rowId: `folder-mention:${catalogScopeKey(entry.scope)}:${entry.entryId}`,
    label: entry.name,
    location: entry.path.slice(0, -1).join("/"),
    action: { type: "select", reference },
  };
}

/** Verify that catalog syntax already carries the stable authority F1 promised. */
export function canonicalReferenceUri(
  scope: CatalogScope,
  uri: CanonicalContextUri,
  authorities: ReferenceAuthorityIndex,
): CanonicalContextUri | null {
  const authority = stableAuthority(scope, authorities, uri);
  return authority ? referenceUriForAuthority(uri, authority) : null;
}

/**
 * One ordering policy for terminal and navigable rows.
 *
 * Exact, prefix, word-start, contains, and fuzzy are strict tiers. Priors can
 * only move a row inside its tier, and the caller's normalized tree order is
 * the final tie breaker. Stable identity is deduplicated before the final cap.
 */
export function rankReferenceRows(
  rows: readonly ReferenceRow[],
  query: string,
  options: ReferencePolicyOptions = {},
  limit = REFERENCE_ROW_LIMIT,
): ReferenceRow[] {
  if (!validReferenceQuery(query) || limit <= 0) return [];
  const needle = normalizeReferenceName(query);
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const ranked: RankedRow[] = [];

  rows.forEach((row, order) => {
    if (row.kind === "file" && kinds && !kinds.has(row.fileKind)) return;
    const match = bestNameMatch(
      row.label,
      row.kind === "file" ? row.aliases : row.kind === "folder-mention" ? [] : row.matchAliases,
      needle,
    );
    if (!match) return;
    const documentId = row.kind === "file" ? row.action.reference.documentId : null;
    ranked.push({
      row,
      tier: match.tier,
      primary: match.matchedAlias === null ? 0 : 1,
      open: documentId && options.openDocumentIds?.has(documentId) ? 0 : 1,
      contextual: documentId && options.contextualDocumentIds?.has(documentId) ? 0 : 1,
      order,
      matchedAlias: match.matchedAlias,
    });
  });

  ranked.sort(
    (left, right) =>
      left.tier - right.tier ||
      left.primary - right.primary ||
      left.open - right.open ||
      left.contextual - right.contextual ||
      left.order - right.order,
  );

  const seen = new Set<string>();
  const result: ReferenceRow[] = [];
  for (const match of ranked) {
    const identity = canonicalRowIdentity(match.row);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(
      match.row.kind === "file" ? { ...match.row, matchedAlias: match.matchedAlias } : match.row,
    );
    if (result.length === limit) break;
  }
  return result;
}

export function validReferenceQuery(query: string): boolean {
  return query.length <= MAX_REFERENCE_QUERY_LENGTH && !/[\r\n[\]|]/u.test(query);
}

export function normalizeReferenceName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function stableAuthority(
  scope: CatalogScope,
  authorities: ReferenceAuthorityIndex,
  uri: CanonicalContextUri,
): StableReferenceAuthority | null {
  switch (scope.kind) {
    case "lineage": {
      // The scope names the lineage by id; the handle is only in the URI it spells.
      const parsed = parseContextUri(uri);
      return parsed.ok && parsed.value.authority.kind === "lineage"
        ? {
            kind: "lineage",
            projectId: scope.projectId,
            rootThreadId: scope.rootThreadId,
            rootThreadRef: parsed.value.authority.rootThreadRef,
          }
        : null;
    }
    case "project":
      return { kind: "project", projectId: scope.projectId };
    case "user":
      return { kind: "user", userId: scope.userId };
    case "chat": {
      // The scope already names the chat; its handle only appears once the chat exists.
      const parsed = parseContextUri(uri);
      return {
        kind: "chat",
        projectId: scope.projectId,
        chatId: scope.chatId,
        chatRef:
          parsed.ok && parsed.value.authority.kind === "chat"
            ? parsed.value.authority.chatRef
            : null,
      };
    }
    case "work": {
      const entry = authorities.get(`work:${scope.workId}`);
      if (!entry) return null;
      return {
        kind: "work",
        projectId: scope.projectId,
        workId: scope.workId,
        workHandle: entry.authority.workHandle,
      };
    }
  }
}

export function referenceUriForAuthority(
  uri: CanonicalContextUri,
  authority: StableReferenceAuthority,
): CanonicalContextUri | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok) return null;
  if (authority.kind === "lineage")
    return parsed.value.scheme === "scratch" &&
      parsed.value.authority.kind === "lineage" &&
      parsed.value.authority.rootThreadRef === authority.rootThreadRef
      ? parsed.value.normalized
      : null;
  if (authority.kind === "chat") {
    // A New chat's upload has no handle yet, so its URI is whatever the intake issued.
    if (parsed.value.scheme !== "uploads") return null;
    return authority.chatRef === null ||
      (parsed.value.authority.kind === "chat" &&
        parsed.value.authority.chatRef === authority.chatRef)
      ? parsed.value.normalized
      : null;
  }
  if (authority.kind === "work") {
    return parsed.value.authority.kind === "work" &&
      parsed.value.authority.workHandle === authority.workHandle
      ? parsed.value.normalized
      : null;
  }
  return (authority.kind === "project" || authority.kind === "user") &&
    parsed.value.authority.kind === "contextual" &&
    parsed.value.scheme !== "scratch" &&
    parsed.value.scheme !== "uploads"
    ? parsed.value.normalized
    : null;
}

function authorityKey(authority: CatalogAuthorityEntry["authority"]): string {
  return `work:${authority.workId}`;
}

function canonicalRowIdentity(row: ReferenceRow): string {
  if (row.kind === "file") return `file:${row.action.reference.documentId}`;
  if (row.kind === "folder-mention") return `mention:${row.action.reference.folderId}`;
  if (row.kind === "authority") return `authority:${JSON.stringify(row.action.scope)}`;
  return `${row.kind}:${row.action.scope.kind}:${row.action.containerId ?? row.action.prefix}`;
}

function bestNameMatch(
  label: string,
  aliases: readonly string[],
  needle: string,
): { tier: number; matchedAlias: string | null } | null {
  const labelTier = lexicalTier(label, needle);
  let best: { tier: number; matchedAlias: string | null } | null =
    labelTier === null ? null : { tier: labelTier, matchedAlias: null };
  for (const alias of aliases) {
    const tier = lexicalTier(alias, needle);
    if (tier !== null && (!best || tier < best.tier)) best = { tier, matchedAlias: alias };
  }
  return best;
}

function lexicalTier(candidate: string, needle: string): number | null {
  if (!needle) return 5;
  const value = normalizeReferenceName(candidate);
  if (value === needle) return 0;
  if (value.startsWith(needle)) return 1;
  if (wordStarts(value).some((index) => value.startsWith(needle, index))) return 2;
  if (value.includes(needle)) return 3;
  return isSubsequence(needle, value) ? 4 : null;
}

function wordStarts(value: string): number[] {
  const starts: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    if (!/[\p{L}\p{N}]/u.test(value[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(value[index] ?? "")) {
      starts.push(index);
    }
  }
  return starts;
}

function isSubsequence(needle: string, value: string): boolean {
  let index = 0;
  for (const character of value) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}
