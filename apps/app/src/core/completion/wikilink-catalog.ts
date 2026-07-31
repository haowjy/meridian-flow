/**
 * What a `[[…]]` may name: the project's documents, ranked by title.
 *
 * A wikilink resolves by title or alias, so this ranks titles and nothing
 * else — a document the writer picks here has to be a document the resolver
 * will find, or the link lands dashed the moment it is inserted.
 *
 * The create row is an item rather than a footer, because the keyboard has to
 * be able to reach it: Enter on it inserts an unresolved wikilink deliberately
 * (mockup 06 state D, "links now, page later"). It never creates a document.
 *
 * The ranking is the whole reason this is not filed under the editor: a
 * `[[Name]]` spliced into the composer's textarea has to offer the same
 * documents in the same order as the one typed in prose, and nothing here reads
 * a document, a view, or a caret. See the module header in
 * [`index.ts`](index.ts).
 */

export type WikilinkDocument = {
  /** Exactly what `[[…]]` must spell to reach it. */
  title: string;
  /** Where it lives, for the row's quiet second column. */
  location: string;
  /** Aliases resolve too, so a writer who recalls one should find the page. */
  aliases?: readonly string[];
};

export type WikilinkCatalog = {
  /** The listbox's accessible name; localized by the host that offers it. */
  label: string;
  documents: readonly WikilinkDocument[];
};

export type WikilinkMenuItem =
  | {
      kind: "document";
      /** Stable within one list; the row's React key and option id. */
      key: string;
      /** The name the link will carry. */
      name: string;
      location: string;
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
  | { kind: "create"; key: "create"; name: string };

/** Longer queries are a writer who kept typing past a menu that had no answer. */
const MAX_QUERY_LENGTH = 80;

const MAX_DOCUMENT_ROWS = 20;

/**
 * The rows for what the writer has typed after `[[`.
 *
 * An empty list closes the menu (law 5), which is what a query the wire format
 * cannot carry should do: `]` or `|` inside the brackets is not a wikilink at
 * all, so a writer who closes the brackets themselves is simply left alone.
 */
export function filterWikilinkItems(
  documents: readonly WikilinkDocument[],
  query: string,
): WikilinkMenuItem[] {
  const name = query.trim();
  if (query.length > MAX_QUERY_LENGTH || /[\r\n[\]|]/.test(query)) return [];

  const duplicated = duplicatedNames(documents);
  const matched = rankDocuments(documents, name)
    .slice(0, MAX_DOCUMENT_ROWS)
    .map(({ document, matchedAlias }, index) => ({
      kind: "document" as const,
      key: `document-${index}-${document.title}`,
      name: document.title,
      location: document.location,
      matchedAlias,
      ambiguous: duplicated.has(normalized(document.title)),
    }));

  // Naming a document that already exists is how a writer makes their own link
  // ambiguous, so the create row steps aside for an exact match.
  const exists = matched.some((item) => normalized(item.name) === normalized(name));
  return name && !exists ? [...matched, { kind: "create" as const, key: "create", name }] : matched;
}

type RankedDocument = {
  document: WikilinkDocument;
  matchedAlias: string | null;
  rank: number;
  order: number;
};

function rankDocuments(
  documents: readonly WikilinkDocument[],
  query: string,
): { document: WikilinkDocument; matchedAlias: string | null }[] {
  const needle = normalized(query);
  const ranked: RankedDocument[] = [];

  documents.forEach((document, order) => {
    const best = bestMatch(document, needle);
    if (best) ranked.push({ ...best, document, order });
  });

  // Ties keep the order the host handed them in, which is tree order: the
  // manuscript reads top to bottom and so does the menu.
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ document, matchedAlias }) => ({ document, matchedAlias }));
}

function bestMatch(
  document: WikilinkDocument,
  needle: string,
): { rank: number; matchedAlias: string | null } | null {
  const title = matchRank(document.title, needle);
  if (title !== null) return { rank: title, matchedAlias: null };

  for (const alias of document.aliases ?? []) {
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
function duplicatedNames(documents: readonly WikilinkDocument[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const document of documents) {
    const name = normalized(document.title);
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return twice;
}

/** The resolver's own comparison, so the menu agrees with it about a match. */
function normalized(value: string): string {
  return value.trim().toLowerCase();
}
