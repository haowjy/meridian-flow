/**
 * The slash catalog — what the menu offers, and who says so.
 *
 * This is the seam that survived the toolkit demolition (§8: "salvage the
 * catalog getter, rewrite the trigger"): the item shape, the fuzzy filter, and
 * the read-at-open getter. The host owns the catalog because the labels are
 * localized and the image entry needs the host's file picker; everything else
 * in this directory builds around it.
 *
 * Ids are a closed union on purpose. The surface renders an icon per id and
 * `slash-insertion.ts` builds a node per id, so an entry that reached the
 * catalog without either is a compile error rather than a blank row.
 */

export type SlashCommandId =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bullet-list"
  | "numbered-list"
  | "quote"
  | "divider"
  | "table"
  | "diagram"
  | "code"
  | "image";

/** The menu's two halves (§5.7): retype this block, or make a new object. */
export type SlashCommandGroupId = "text" | "insert";

export type SlashCommandItem = {
  id: SlashCommandId;
  group: SlashCommandGroupId;
  label: string;
  aliases: readonly string[];
  /** A second line of answer for entries whose result is not obvious. */
  hint?: string;
};

export type SlashCommandCatalog = {
  items: readonly SlashCommandItem[];
  menuLabel: string;
  groupLabels: Record<SlashCommandGroupId, string>;
  /**
   * Required, not optional: `Image` is a visible row, and a host that offers
   * the catalog without a picker offers a row that eats the trigger text and
   * shows nothing. A surface with no picker returns no catalog at all.
   */
  requestImageUpload: () => void;
};

export type SlashCommandExtensionOptions = {
  /**
   * Read when the menu opens, never at construction. The catalog carries
   * localized labels and host callbacks that must stay live; making them
   * construction facts would put a locale switch on the editor's remount path.
   * Return null to leave the menu off for this surface.
   */
  catalog: () => SlashCommandCatalog | null;
};

function fuzzyScore(value: string, query: string): number | null {
  const candidate = value.toLocaleLowerCase();
  if (candidate.startsWith(query)) return 0;
  if (candidate.split(/\s+/u).some((word) => word.startsWith(query))) return 1;

  let queryIndex = 0;
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return 2;
  }
  return null;
}

/** Fuzzy label + alias filtering; stable ties preserve the writer-first catalog order. */
export function filterSlashCommandItems(
  items: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...items];

  return items
    .map((item, order) => ({
      item,
      order,
      score: Math.min(
        ...[item.label, ...item.aliases].map(
          (value) => fuzzyScore(value, normalizedQuery) ?? Number.POSITIVE_INFINITY,
        ),
      ),
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(({ item }) => item);
}
