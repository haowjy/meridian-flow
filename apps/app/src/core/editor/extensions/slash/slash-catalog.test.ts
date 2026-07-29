/** Behavioral contract for the surviving slash catalog seam: fuzzy matching. */
import { describe, expect, it } from "vitest";

import { filterSlashCommandItems, type SlashCommandItem } from "./slash-catalog";

const ITEMS = [
  { id: "divider", group: "text", label: "Divider", aliases: ["scene break", "hr", "rule"] },
  { id: "heading-1", group: "text", label: "Heading 1", aliases: ["title", "h1"] },
  { id: "table", group: "insert", label: "Table", aliases: ["grid", "stat block", "litrpg"] },
] satisfies SlashCommandItem[];

describe("slash command filtering", () => {
  it("fuzzy matches labels and aliases while preserving catalog order for ties", () => {
    expect(filterSlashCommandItems(ITEMS, "stbl").map(({ id }) => id)).toEqual(["table"]);
    expect(filterSlashCommandItems(ITEMS, "scene").map(({ id }) => id)).toEqual(["divider"]);
    expect(filterSlashCommandItems(ITEMS, "").map(({ id }) => id)).toEqual([
      "divider",
      "heading-1",
      "table",
    ]);
  });
});
