/**
 * Slash-command catalog seam.
 *
 * The trigger plugin was deleted with the rest of the condemned editor chrome
 * (interaction model §8: "salvage the catalog getter, rewrite the trigger").
 * What survives is the seam the host already speaks: the item/catalog shape,
 * the fuzzy filter, and the read-at-open getter. The extension therefore
 * currently mounts no ProseMirror plugin — typing `/` inserts a literal slash
 * until the rebuild lands a trigger against the new contract.
 */
import { Extension } from "@tiptap/core";

export type SlashCommandId =
  | "scene-break"
  | "heading"
  | "quote"
  | "bullet-list"
  | "numbered-list"
  | "table"
  | "image"
  | "code"
  | "diagram";

export type SlashCommandItem = {
  id: SlashCommandId;
  label: string;
  aliases: readonly string[];
};

export type SlashCommandCatalog = {
  items: readonly SlashCommandItem[];
  menuLabel: string;
  requestImageUpload?: () => void;
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

export const SlashCommandExtension = Extension.create<SlashCommandExtensionOptions>({
  name: "slashCommand",

  addOptions() {
    return { catalog: () => null };
  },
});
