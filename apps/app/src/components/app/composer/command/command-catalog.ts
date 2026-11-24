export const RESERVED_COMPOSER_COMMAND_SLUGS: ReadonlySet<string> = new Set([
  "compact",
  "handoff",
  "clear",
]);

export type ComposerCommandGroupId = "skills" | "chat";

export type ComposerChatCommandSlug = "compact";

export type ComposerChatCommand = {
  slug: ComposerChatCommandSlug;
  name: string;
  description: string;
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
