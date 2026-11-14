/**
 * Combines what the levels hold by name. Pure: no files, no store.
 *
 * A level owns every name it contains, readable or not, so an item that is broken or ambiguous
 * stays in its level, unavailable, and still hides the same name below it.
 */
import type { AgentLevel } from "@meridian/contracts/agents";

export interface LevelItems<T> {
  level: AgentLevel;
  /** The level's own items: they win their names over every import, silently. */
  root: Array<{ name: string; value: T }>;
  /** Imported packages by name; two that bring one name clash. */
  imports: Array<{ package: string; items: Array<{ name: string; value: T }> }>;
}

export interface Combined<T> {
  /** The name the writer picks by: the file's name, or `name__package` after a clash. */
  slug: string;
  level: AgentLevel;
  /** Lower levels that have the same name, now hidden. */
  shadows: AgentLevel[];
  /** Null when the name is held but unusable: two packages bring it, or a renamed name collides. */
  value: T | null;
  /** Why `value` is null. */
  clash?: string;
}

type Entry<T> = { value: T | null; clash?: string };

/** Within a level: the root wins its names; among packages, a shared name renames both. */
function withinLevel<T>(level: LevelItems<T>): Map<string, Entry<T>> {
  const names = new Map<string, Entry<T>>();
  for (const { name, value } of level.root) names.set(name, { value });

  const bringers = new Map<string, Array<{ package: string; value: T }>>();
  for (const pkg of level.imports) {
    for (const { name, value } of pkg.items) {
      if (names.has(name)) continue;
      bringers.set(name, [...(bringers.get(name) ?? []), { package: pkg.package, value }]);
    }
  }
  const renamed: Array<[string, Array<{ package: string; value: T }>]> = [];
  for (const [name, list] of bringers) {
    if (list.length === 1) names.set(name, { value: list[0].value });
    else renamed.push([name, list]);
  }
  for (const [name, list] of renamed) {
    const choices = list.map((item) => `${name}__${item.package}`);
    names.set(name, {
      value: null,
      clash: `Two packages bring ${name}: choose ${choices.join(" or ")}`,
    });
  }
  for (const [name, list] of renamed) {
    for (const { package: pkg, value } of list) {
      const slug = `${name}__${pkg}`;
      const taken = names.get(slug);
      names.set(
        slug,
        taken
          ? { value: null, clash: `${slug} is both a renamed ${name} and another Agent` }
          : { value },
      );
    }
  }
  return names;
}

/** `levels` run from lowest to highest priority. */
export function combineByName<T>(levels: LevelItems<T>[]): Combined<T>[] {
  const result = new Map<string, Combined<T>>();
  for (const level of levels) {
    for (const [slug, entry] of withinLevel(level)) {
      const below = result.get(slug);
      result.set(slug, {
        slug,
        level: level.level,
        shadows: below ? [below.level, ...below.shadows] : [],
        value: entry.value,
        ...(entry.clash ? { clash: entry.clash } : {}),
      });
    }
  }
  return [...result.values()];
}
