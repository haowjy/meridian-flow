/**
 * What a reference may name, and in what order a menu should offer it.
 *
 * One ranking for every trigger. `[[` in prose, `@` in prose, `@` in the
 * chat composer and the href slot are four ways of asking the same
 * question — "which thing did the writer mean?" — and a second implementation
 * of the answer is two menus that disagree about one query, one of which
 * disagrees with the resolver.
 *
 * A candidate is a thing that exists; an item is a row a trigger may offer for
 * it. `scope` is the difference: the same catalog answers `[[` with documents
 * alone and `@` with documents and assets, so a host hands over everything it
 * has once and each trigger asks for its own half.
 *
 * Names rank the way the resolver matches them — title, then alias, normalized
 * the way the server normalizes — because a row the resolver cannot find is a
 * link that lands dashed the moment it is inserted.
 */

/** Reserved: `"person"` joins when a people domain exists to name. */
export type ReferenceKind = "document" | "asset";

/**
 * A thing in the project a reference could point at.
 *
 * Documents carry `documentId` and the canonical `uri` even though prose only
 * ever spells the title: a pick has to be able to escape a shared title by
 * naming identity instead, and rebuilding identity above this boundary would
 * mean asking the tree twice.
 */
export type ReferenceCandidate =
  | {
      kind: "document";
      /** Exactly what `[[…]]` must spell to reach it. */
      title: string;
      /** Where it lives, for the row's quiet second column. */
      location: string;
      /** The persisted `documents.id`, which is what a follow opens. */
      documentId: string;
      /** The resolver's spelling, which a relative link resolves against. */
      uri: string;
      /** Aliases resolve too, so a writer who recalls one should find the page. */
      aliases?: readonly string[];
    }
  | {
      kind: "asset";
      /** The filename, extension and all: `map.png` is not the chapter `map`. */
      name: string;
      location: string;
      /** Assets are documents rows too; this is the id a figure src carries. */
      assetDocumentId: string;
      /** Slash-prefixed display path, for the row and for an alt text. */
      path: string;
      fileType: string;
      /**
       * The canonical context URI (`manuscript://assets/…`). Assets resolve by
       * id, never by name, so a surface that can only write text — the
       * composer's token spelling, an image block — names one by this instead.
       */
      uri: string;
    };

/** What a host offers a trigger: everything it can name, plus the menu's name. */
export type ReferenceCatalog = {
  /** The listbox's accessible name; localized by the host that offers it. */
  label: string;
  candidates: readonly ReferenceCandidate[];
};

export type ReferenceItem =
  | {
      kind: "document";
      /** Stable within one list; the row's React key and option id. */
      key: string;
      /** The name the link will carry. */
      name: string;
      location: string;
      /** The persisted `documents.id`, carried through from the candidate. */
      documentId: string;
      /**
       * The resolver's spelling of this document. A host that cannot spell the
       * name — the composer picking one of two chapters called Notes — writes
       * this instead, and it must be the pick's own URI rather than one looked
       * up again from a catalog that may have moved.
       */
      uri: string;
      /** Which alias matched, when the writer recalled one instead of the title. */
      matchedAlias: string | null;
      /**
       * Another document answers to this same name, so the resolver will refuse
       * both (ambiguity resolves to nothing rather than to a guess). The row
       * says so; picking it still inserts, because renaming one of the two is
       * the writer's fix and not the menu's.
       */
      ambiguous: boolean;
    }
  | {
      kind: "asset";
      key: string;
      name: string;
      location: string;
      assetDocumentId: string;
      path: string;
      /**
       * Carried through so a pick knows what it took: only an `image` can
       * ride a message as an image block; every other file is
       * designation-only.
       */
      fileType: string;
      /** The candidate's canonical URI, carried through for the same reason. */
      uri: string;
    }
  | { kind: "create"; key: "create"; name: string };

/**
 * The rows a given scope can produce. `[[` asks for documents and therefore
 * cannot be handed an asset row, and the menu that renders it should not have
 * to carry a branch for a state it will never see.
 */
export type ReferenceItemOf<TKind extends ReferenceKind> = Extract<
  ReferenceItem,
  { kind: TKind | "create" }
>;

/** Longer queries are a writer who kept typing past a menu that had no answer. */
export const MAX_REFERENCE_QUERY_LENGTH = 80;

const MAX_CANDIDATE_ROWS = 20;

/**
 * Browsing keeps a seat for pictures. An empty query ranks every candidate
 * equal, and documents sort ahead of assets on ties, so a project past twenty
 * documents would fill the whole cap with them — the menu would read "no
 * pictures" when the truth is "type to narrow". So while the writer is still
 * browsing, assets keep a floor of rows (fewer when fewer exist, more when the
 * documents cannot fill their share), and the total still honors the cap. A
 * typed query is not this: it ranks by fit and takes the top rows regardless
 * of kind.
 */
const BROWSE_ASSET_FLOOR = 4;

/**
 * The rows for what the writer has typed after a trigger.
 *
 * An empty list closes the menu (law 5). A trigger whose own spelling cannot
 * carry a query — `]` or `|` after `[[` — refuses it before asking here, so
 * this stays about what exists rather than about how one trigger spells it.
 */
export function filterReferenceItems<TKind extends ReferenceKind>(
  candidates: readonly ReferenceCandidate[],
  scope: readonly TKind[],
  query: string,
): ReferenceItemOf<TKind>[] {
  if (query.length > MAX_REFERENCE_QUERY_LENGTH) return [];
  const name = query.trim();
  const kinds: readonly ReferenceKind[] = scope;

  const inScope = candidates.filter((candidate) => kinds.includes(candidate.kind));
  const duplicated = duplicatedTitles(inScope);
  const ranked = rank(inScope, name);
  const capped = name ? ranked.slice(0, MAX_CANDIDATE_ROWS) : browseRows(ranked);
  const matched: ReferenceItem[] = capped.map(({ candidate, matchedAlias }, index) =>
    candidate.kind === "document"
      ? {
          kind: "document",
          key: `document-${index}-${candidate.title}`,
          name: candidate.title,
          location: candidate.location,
          documentId: candidate.documentId,
          uri: candidate.uri,
          matchedAlias,
          ambiguous: duplicated.has(normalized(candidate.title)),
        }
      : {
          kind: "asset",
          key: `asset-${index}-${candidate.name}`,
          name: candidate.name,
          location: candidate.location,
          assetDocumentId: candidate.assetDocumentId,
          path: candidate.path,
          fileType: candidate.fileType,
          uri: candidate.uri,
        },
  );

  // Naming a document that already exists is how a writer makes their own link
  // ambiguous, so the create row steps aside for an exact match. An asset of the
  // same name is not that: the resolver never sees it.
  const exists = matched.some(
    (item) => item.kind === "document" && normalized(item.name) === normalized(name),
  );
  const items =
    name && kinds.includes("document") && !exists
      ? [...matched, { kind: "create" as const, key: "create" as const, name }]
      : matched;

  // Every row came from a candidate `scope` admitted, plus a create row only a
  // document scope reaches. The compiler cannot follow that through the map, so
  // the promise the signature makes is asserted once, here.
  return items as ReferenceItemOf<TKind>[];
}

/**
 * The browse-state cap: documents first and most, assets never starved. The
 * ranked list already reads documents-then-assets in tree order, so taking a
 * slice of each keeps that order intact.
 */
function browseRows(
  ranked: readonly { candidate: ReferenceCandidate; matchedAlias: string | null }[],
): { candidate: ReferenceCandidate; matchedAlias: string | null }[] {
  if (ranked.length <= MAX_CANDIDATE_ROWS) return [...ranked];
  const assets = ranked.filter(({ candidate }) => candidate.kind === "asset");
  const floor = Math.min(assets.length, BROWSE_ASSET_FLOOR);
  const documents = ranked
    .filter(({ candidate }) => candidate.kind !== "asset")
    .slice(0, MAX_CANDIDATE_ROWS - floor);
  return [...documents, ...assets.slice(0, MAX_CANDIDATE_ROWS - documents.length)];
}

type RankedCandidate = {
  candidate: ReferenceCandidate;
  matchedAlias: string | null;
  rank: number;
  order: number;
};

/** Documents before assets when both matched equally: prose names prose first. */
const KIND_ORDER: Record<ReferenceKind, number> = { document: 0, asset: 1 };

function rank(
  candidates: readonly ReferenceCandidate[],
  query: string,
): { candidate: ReferenceCandidate; matchedAlias: string | null }[] {
  const needle = normalized(query);
  const ranked: RankedCandidate[] = [];

  candidates.forEach((candidate, order) => {
    const best = bestMatch(candidate, needle);
    if (best) ranked.push({ ...best, candidate, order });
  });

  // Ties keep the order the host handed them in, which is tree order: the
  // manuscript reads top to bottom and so does the menu.
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind] ||
        a.order - b.order,
    )
    .map(({ candidate, matchedAlias }) => ({ candidate, matchedAlias }));
}

function bestMatch(
  candidate: ReferenceCandidate,
  needle: string,
): { rank: number; matchedAlias: string | null } | null {
  if (candidate.kind === "asset") {
    const rank = matchRank(candidate.name, needle);
    return rank === null ? null : { rank, matchedAlias: null };
  }

  const title = matchRank(candidate.title, needle);
  if (title !== null) return { rank: title, matchedAlias: null };

  for (const alias of candidate.aliases ?? []) {
    const rank = matchRank(alias, needle);
    // An alias is a real way to reach the page, one step behind its own title.
    if (rank !== null) return { rank: rank + 0.5, matchedAlias: alias };
  }
  return null;
}

/**
 * The part of a name a writer recalls first: how it starts, then a word inside
 * it, then anywhere at all.
 */
function matchRank(candidate: string, needle: string): number | null {
  if (!needle) return 3;
  const value = normalized(candidate);
  if (value.startsWith(needle)) return 0;
  if (wordStarts(value).some((index) => value.startsWith(needle, index))) return 1;
  return value.includes(needle) ? 2 : null;
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

/** Titles the resolver would find twice, and so resolve to nothing. */
function duplicatedTitles(candidates: readonly ReferenceCandidate[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "document") continue;
    const name = normalized(candidate.title);
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return twice;
}

/** The resolver's own comparison, so the menu agrees with it about a match. */
function normalized(value: string): string {
  return value.trim().toLowerCase();
}
