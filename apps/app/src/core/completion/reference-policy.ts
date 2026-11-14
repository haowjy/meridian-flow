/** Canonical reference identity and deterministic lexical ranking over a source's tree. */
import {
  type CanonicalContextUri,
  type DocumentId,
  type FolderId,
  parseContextUri,
} from "@meridian/contracts";
import type {
  ContextSource,
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { StableReferenceAuthority } from "@meridian/thread-client";
import type { TreeDirectory, TreeFile, TreeView } from "@/core/project-tree/tree-view";

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
};

/** A folder, named by its node; its URI is only where it is now. Area roots are never one. */
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
  sourceId: string;
  containerId?: string;
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

/** A source as the browser lists it: where its addresses point and what the writer calls its owner. */
export type ReferenceSource = {
  id: string;
  scheme: ProjectContextTreeScheme;
  authority: StableReferenceAuthority;
  /** A Work's name for a source it owns; empty for every other owner. */
  ownerLabel: string;
};

export type ReferenceSourceView = { source: ReferenceSource; tree: TreeView };

/** The authority a source's addresses carry. A chat's handle is null until the chat exists. */
export function referenceSourceOf(
  source: ContextSource,
  context: { projectId: string; accountId: string; ownerLabel?: string },
): ReferenceSource {
  const { projectId, accountId } = context;
  const address = source.authority;
  const authority: StableReferenceAuthority =
    source.owner.kind === "work"
      ? {
          kind: "work",
          projectId,
          workId: source.owner.workId,
          workHandle: "workHandle" in address ? address.workHandle : null,
        }
      : source.owner.kind === "lineage"
        ? {
            kind: "lineage",
            projectId,
            rootThreadId: source.owner.rootThreadId,
            rootThreadRef: "rootThreadRef" in address ? address.rootThreadRef : "",
          }
        : source.owner.kind === "chat"
          ? {
              kind: "chat",
              projectId,
              chatId: source.owner.chatId,
              chatRef: "chatRef" in address ? address.chatRef : null,
            }
          : source.scheme === "user"
            ? { kind: "user", userId: accountId }
            : { kind: "project", projectId };
  return {
    id: source.id,
    scheme: source.scheme,
    authority,
    ownerLabel: source.owner.kind === "work" ? (context.ownerLabel ?? "") : "",
  };
}

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

export function authoritativeReferenceForFile(
  file: TreeFile,
  source: ReferenceSource,
): DocumentReference | null {
  const uri = referenceUriForAuthority(file.uri, source.authority);
  if (!uri) return null;
  return {
    kind: "document",
    documentId: file.documentId,
    uri,
    fileType: file.editable ? file.filetype : file.fileType,
    authority: source.authority,
    label: file.name,
  };
}

/** A folder a writer can mention: one whose address carries its source's stable authority. */
export function folderReferenceForEntry(
  dir: TreeDirectory,
  source: ReferenceSource,
): FolderReference | null {
  const uri = referenceUriForAuthority(dir.uri, source.authority);
  return uri ? { kind: "folder", folderId: dir.entryId, uri, label: dir.name } : null;
}

/** The directories above a node, as the row's location: `a/b` for `/a/b/c.md`. */
export function locationOf(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

/** The terminal browser row for a file. */
export function referenceRowForFile(
  file: TreeFile,
  source: ReferenceSource,
): Extract<ReferenceRow, { kind: "file" }> | null {
  const reference = authoritativeReferenceForFile(file, source);
  if (!reference) return null;
  return {
    kind: "file",
    rowId: `file:${file.documentId}`,
    label: file.name,
    location: locationOf(file.path),
    fileKind: file.editable ? "document" : "asset",
    aliases: file.aliases ?? [],
    matchedAlias: null,
    action: { type: "select", reference },
  };
}

/** The terminal browser row that names a folder rather than opening it. */
export function referenceRowForFolder(
  dir: TreeDirectory,
  source: ReferenceSource,
): Extract<ReferenceRow, { kind: "folder-mention" }> | null {
  const reference = folderReferenceForEntry(dir, source);
  if (!reference) return null;
  return {
    kind: "folder-mention",
    rowId: `folder-mention:${source.id}:${dir.entryId}`,
    label: dir.name,
    location: locationOf(dir.path),
    action: { type: "select", reference },
  };
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

export function referenceUriForAuthority(
  uri: string,
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

function canonicalRowIdentity(row: ReferenceRow): string {
  if (row.kind === "file") return `file:${row.action.reference.documentId}`;
  if (row.kind === "folder-mention") return `mention:${row.action.reference.folderId}`;
  if (row.kind === "authority") return `authority:${row.action.sourceId}`;
  return `${row.kind}:${row.action.sourceId}:${row.action.containerId ?? row.action.prefix}`;
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
