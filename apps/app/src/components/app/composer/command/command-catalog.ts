/**
 * Composer `/` catalog: commands, grouped. Skills now; session verbs reserved.
 *
 * Manuscript slash insertion is a different catalog. This one never offers
 * headings, tables, or images.
 */

export const RESERVED_COMPOSER_COMMAND_SLUGS: ReadonlySet<string> = new Set([
  "compact",
  "handoff",
  "clear",
]);

export type ComposerCommandGroupId = "skills" | "chat";

export type ComposerCommandItem = {
  id: string;
  group: ComposerCommandGroupId;
  kind: "skill";
  slug: string;
  label: string;
  name: string;
  description: string;
};

export type ComposerCommandCatalog = {
  items: readonly ComposerCommandItem[];
  menuLabel: string;
  groupLabels: Record<ComposerCommandGroupId, string>;
  activateSkill: (slug: string) => void;
};

export type ComposerAvailableSkill = {
  slug: string;
  name: string;
  description: string;
};

export function composerSkillCommandItems(
  skills: readonly ComposerAvailableSkill[],
): ComposerCommandItem[] {
  return skills
    .filter((skill) => !RESERVED_COMPOSER_COMMAND_SLUGS.has(skill.slug))
    .map((skill) => ({
      id: skill.slug,
      group: "skills",
      kind: "skill",
      slug: skill.slug,
      label: `/${skill.slug}`,
      name: skill.name,
      description: skill.description,
    }));
}

function fuzzyScore(value: string, query: string): number | null {
  const candidate = value.toLocaleLowerCase();
  if (candidate.startsWith(query)) return 0;
  if (candidate.split(/[\s/-]+/u).some((word) => word.startsWith(query))) return 1;

  let queryIndex = 0;
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return 2;
  }
  return null;
}

/** Fuzzy slug + name + description filtering; stable ties keep catalog order. */
export function filterComposerCommandItems(
  items: readonly ComposerCommandItem[],
  query: string,
): ComposerCommandItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase().replace(/^\/+/u, "");
  if (!normalizedQuery) return [...items];

  return items
    .map((item, order) => ({
      item,
      order,
      score: Math.min(
        ...[item.slug, item.name, item.description, item.label].map(
          (value) => fuzzyScore(value, normalizedQuery) ?? Number.POSITIVE_INFINITY,
        ),
      ),
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(({ item }) => item);
}
