/**
 * Composer `/` catalog: commands, grouped. Skills, plus the chat verbs a
 * surface registers (`/compact` today; `handoff` and `clear` stay reserved).
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

/** A chat verb the composer can run. Only reserved slugs qualify. */
export type ComposerChatCommandSlug = "compact";

/** A chat verb registered by the surface that owns the thread. */
export type ComposerChatCommand = {
  slug: ComposerChatCommandSlug;
  name: string;
  description: string;
  /** `instructions` is the text typed after the verb, trimmed; null when none. */
  run: (instructions: string | null) => void;
};

export type ComposerCommandItem =
  | {
      id: string;
      group: "skills";
      kind: "skill";
      slug: string;
      label: string;
      name: string;
      description: string;
    }
  | {
      id: string;
      group: "chat";
      kind: "command";
      slug: ComposerChatCommandSlug;
      label: string;
      name: string;
      description: string;
    };

export type ComposerCommandCatalog = {
  items: readonly ComposerCommandItem[];
  menuLabel: string;
  groupLabels: Record<ComposerCommandGroupId, string>;
  /** Runs a chosen chat verb. Absent when the surface registers none. */
  runCommand?: (slug: ComposerChatCommandSlug) => void;
};

export function composerChatCommandItems(
  commands: readonly ComposerChatCommand[],
): ComposerCommandItem[] {
  return commands.map((command) => ({
    id: `command:${command.slug}`,
    group: "chat",
    kind: "command",
    slug: command.slug,
    label: `/${command.slug}`,
    name: command.name,
    description: command.description,
  }));
}

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

/**
 * A sent draft that is a registered verb: `/compact` alone, or followed by
 * whitespace and the writer's instructions for it. Anything else, including
 * an unregistered verb, sends as an ordinary message.
 */
export function matchComposerChatCommand(
  text: string,
  commands: readonly ComposerChatCommand[],
): { command: ComposerChatCommand; instructions: string | null } | null {
  const match = /^\s*\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/u.exec(text);
  if (!match) return null;
  const command = commands.find((candidate) => candidate.slug === match[1]);
  if (!command) return null;
  const instructions = match[2]?.trim() ?? "";
  return { command, instructions: instructions || null };
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
