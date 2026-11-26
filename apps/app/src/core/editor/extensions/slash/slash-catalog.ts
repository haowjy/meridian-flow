import type { HeadingLevel } from "@meridian/prosemirror-schema";

import type { EditorAnchor } from "../../anchors";

export type SlashCommandId =
  | `heading-${HeadingLevel}`
  | "bullet-list"
  | "numbered-list"
  | "task-list"
  | "quote"
  | "divider"
  | "table"
  | "diagram"
  | "code"
  | "image";

export type SlashCommandGroupId = "text" | "insert";

export type SlashCommandItem = {
  id: SlashCommandId;
  group: SlashCommandGroupId;
  label: string;
  aliases: readonly string[];
  hint?: string;
  onlyWhenSearched?: boolean;
};

export type SlashCommandCatalog = {
  items: readonly SlashCommandItem[];
  menuLabel: string;
  groupLabels: Record<SlashCommandGroupId, string>;
  /**
   * Open the host's picker for a picture that goes at `at`.
   *
   * The anchor is the whole contract. The lane consumes the trigger and pins
   * the place it left behind; the host's chooser then outlives that place —
   * a writer can leave an operating-system dialog open while their own caret
   * moves and peers rewrite the chapter — and only the anchor still knows where
   * the picture was asked for.
   *
   * Required, not optional: `Image` is a visible row, and a host that offers
   * the catalog without a picker offers a row that eats the trigger text and
   * shows nothing. A surface with no picker returns no catalog at all.
   */
  requestImageUpload: (at: EditorAnchor) => void;
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

export function filterSlashCommandItems(
  items: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return items.filter((item) => !item.onlyWhenSearched);

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
