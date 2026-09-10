/** Canonical reference identity and deterministic lexical ranking over catalog metadata. */
import {
  type CanonicalContextUri,
  type DocumentId,
  type ProjectId,
  parseContextUri,
  type UserId,
  type WorkId,
} from "@meridian/contracts";
import type {
  CatalogAuthorityEntry,
  CatalogFileEntry,
  CatalogScope,
  DocumentFileType,
  Filetype,
} from "@meridian/contracts/protocol";
import type { WorkSlug } from "@meridian/contracts/works";

export const REFERENCE_ROW_LIMIT = 20;
export const MAX_REFERENCE_QUERY_LENGTH = 80;

export type StableReferenceAuthority =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "none"; projectId: ProjectId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId; workSlug: WorkSlug };

export type AuthoritativeReference = {
  documentId: DocumentId;
  uri: CanonicalContextUri;
  fileType: Filetype | DocumentFileType;
  authority: StableReferenceAuthority;
  label: string;
};

export type ReferenceNavigationAction = {
  type: "navigate";
  /** One authority segment or a full canonical source/folder prefix. */
  prefix: string;
  scope: CatalogScope;
  containerId?: string;
  /** Only authority activation crosses from warm metadata into scope acquisition. */
  acquire: boolean;
};

export type ReferenceSelectAction = {
  type: "select";
  reference: AuthoritativeReference;
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
  | (NavigationRowBase & { kind: "authority"; authorityKind: "work" | "none" })
  | (NavigationRowBase & { kind: "folder" })
  | {
      kind: "file";
      rowId: string;
      label: string;
      location: string;
      fileKind: "document" | "asset";
      aliases: readonly string[];
      matchedAlias: string | null;
      ambiguous: boolean;
      action: ReferenceSelectAction;
    };

export type ReferenceAuthorityIndex = ReadonlyMap<string, CatalogAuthorityEntry>;

export type ReferenceRankingPriors = {
  openDocumentIds?: ReadonlySet<string>;
  contextualDocumentIds?: ReadonlySet<string>;
};

export type ReferenceKind = "document" | "asset";

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
): AuthoritativeReference | null {
  const authority = stableAuthority(entry.scope, authorities);
  if (!authority) return null;
  const uri = verifiedCanonicalUri(entry.scope, entry.uri, authority);
  if (!uri) return null;

  return {
    documentId: entry.entryId,
    uri,
    fileType: entry.editable ? entry.filetype : entry.fileType,
    authority,
    label: entry.name,
  };
}

/** Verify that catalog syntax already carries the stable authority F1 promised. */
export function canonicalReferenceUri(
  scope: CatalogScope,
  uri: CanonicalContextUri,
  authorities: ReferenceAuthorityIndex,
): CanonicalContextUri | null {
  const authority = stableAuthority(scope, authorities);
  return authority ? verifiedCanonicalUri(scope, uri, authority) : null;
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
  const ambiguousNames = duplicatedResolvableNames(rows);
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const ranked: RankedRow[] = [];

  rows.forEach((row, order) => {
    if (row.kind === "file" && kinds && !kinds.has(row.fileKind)) return;
    const match = bestRowMatch(row, needle);
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
      match.row.kind === "file"
        ? {
            ...match.row,
            matchedAlias: match.matchedAlias,
            ambiguous:
              ambiguousNames.has(normalizeReferenceName(match.row.label)) ||
              (match.matchedAlias !== null &&
                ambiguousNames.has(normalizeReferenceName(match.matchedAlias))),
          }
        : match.row,
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
): StableReferenceAuthority | null {
  switch (scope.kind) {
    case "project":
      return { kind: "project", projectId: scope.projectId };
    case "user":
      return { kind: "user", userId: scope.userId };
    case "none":
      return { kind: "none", projectId: scope.projectId };
    case "work": {
      const entry = authorities.get(`work:${scope.workId}`);
      if (entry?.authority.kind !== "work") return null;
      return {
        kind: "work",
        projectId: scope.projectId,
        workId: scope.workId,
        workSlug: entry.authority.workSlug,
      };
    }
  }
}

function verifiedCanonicalUri(
  scope: CatalogScope,
  uri: CanonicalContextUri,
  authority: StableReferenceAuthority,
): CanonicalContextUri | null {
  const parsed = parseContextUri(uri);
  if (!parsed.ok) return null;
  if (authority.kind === "work") {
    return parsed.value.authority.kind === "work" &&
      parsed.value.authority.workSlug === authority.workSlug
      ? parsed.value.normalized
      : null;
  }
  if (authority.kind === "none") {
    return parsed.value.authority.kind === "none" ? parsed.value.normalized : null;
  }
  return (scope.kind === "project" || scope.kind === "user") &&
    parsed.value.authority.kind === "contextual" &&
    parsed.value.scheme !== "scratch" &&
    parsed.value.scheme !== "uploads"
    ? parsed.value.normalized
    : null;
}

function authorityKey(authority: CatalogAuthorityEntry["authority"]): string {
  return authority.kind === "none" ? "none" : `work:${authority.workId}`;
}

function canonicalRowIdentity(row: ReferenceRow): string {
  if (row.kind === "file") return `file:${row.action.reference.documentId}`;
  if (row.kind === "authority") return `authority:${JSON.stringify(row.action.scope)}`;
  return `${row.kind}:${row.action.scope.kind}:${row.action.containerId ?? row.action.prefix}`;
}

function bestRowMatch(
  row: ReferenceRow,
  needle: string,
): { tier: number; matchedAlias: string | null } | null {
  const labelTier = lexicalTier(row.label, needle);
  let best: { tier: number; matchedAlias: string | null } | null =
    labelTier === null ? null : { tier: labelTier, matchedAlias: null };
  const aliases = row.kind === "file" ? row.aliases : row.matchAliases;
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

function duplicatedResolvableNames(rows: readonly ReferenceRow[]): ReadonlySet<string> {
  const identitiesByName = new Map<string, Set<string>>();
  const duplicated = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "file") continue;
    for (const spelling of [row.label, ...row.aliases]) {
      const name = normalizeReferenceName(spelling);
      const identities = identitiesByName.get(name) ?? new Set<string>();
      identities.add(row.action.reference.documentId);
      identitiesByName.set(name, identities);
      if (identities.size > 1) duplicated.add(name);
    }
  }
  return duplicated;
}
