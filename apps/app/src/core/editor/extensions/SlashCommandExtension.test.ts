/** Behavioral contract for the surviving slash catalog seam: fuzzy matching. */
import { describe, expect, it } from "vitest";

import { filterSlashCommandItems, type SlashCommandItem } from "./SlashCommandExtension";

const ITEMS = [
  { id: "scene-break", label: "Scene break", aliases: ["divider", "hr", "rule", "break"] },
  { id: "heading", label: "Heading", aliases: ["title", "h1", "h2", "section"] },
  { id: "table", label: "Table", aliases: ["grid", "stat block", "status", "litrpg"] },
] satisfies SlashCommandItem[];

describe("slash command filtering", () => {
  it("fuzzy matches labels and aliases while preserving catalog order for ties", () => {
    expect(filterSlashCommandItems(ITEMS, "stbl").map(({ id }) => id)).toEqual(["table"]);
    expect(filterSlashCommandItems(ITEMS, "br").map(({ id }) => id)).toEqual(["scene-break"]);
    expect(filterSlashCommandItems(ITEMS, "").map(({ id }) => id)).toEqual([
      "scene-break",
      "heading",
      "table",
    ]);
  });
});
