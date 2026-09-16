import { describe, expect, it } from "vitest";

import {
  composerSkillCommandItems,
  filterComposerCommandItems,
  RESERVED_COMPOSER_COMMAND_SLUGS,
} from "./command-catalog";

const skills = [
  {
    slug: "creative-writing-modes",
    name: "Creative writing modes",
    description: "Modes for putting prose on the page.",
  },
  {
    slug: "writing-principles",
    name: "Writing principles",
    description: "Reader reward and LLM fiction failure modes.",
  },
  {
    slug: "compact",
    name: "Compact",
    description: "A skill must not take this session verb.",
  },
];

describe("composer command catalog", () => {
  it("emits Skills rows as /slug and reserves session verbs", () => {
    const items = composerSkillCommandItems(skills);
    expect(items.map((item) => item.label)).toEqual([
      "/creative-writing-modes",
      "/writing-principles",
    ]);
    expect(RESERVED_COMPOSER_COMMAND_SLUGS.has("compact")).toBe(true);
    expect(items.some((item) => item.slug === "compact")).toBe(false);
  });

  it("filters by slug as the writer types after /", () => {
    const items = composerSkillCommandItems(skills);
    expect(filterComposerCommandItems(items, "creative").map((item) => item.slug)).toEqual([
      "creative-writing-modes",
    ]);
    expect(filterComposerCommandItems(items, "/writing-p").map((item) => item.slug)).toEqual([
      "writing-principles",
    ]);
  });
});
