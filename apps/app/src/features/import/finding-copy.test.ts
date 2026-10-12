import { i18n } from "@lingui/core";
import type { ImportFinding } from "@meridian/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  findingGroup,
  findingSentence,
  keptAsTextSentence,
  readableLocation,
} from "./finding-copy";

describe("finding copy", () => {
  beforeAll(() => i18n.loadAndActivate({ locale: "en", messages: {} }));

  it("says a location as the writer reads it, never as an address", () => {
    expect(readableLocation("kb://vault/Lore/Magic System")).toBe(
      "Knowledge Base / vault / Lore / Magic System",
    );
    expect(readableLocation("manuscript://Book/Ch 1")).toBe("Manuscript / Book / Ch 1");
  });

  it("lists the files an ambiguous link did not pick, one per line", () => {
    const finding = {
      code: "link_ambiguous",
      params: {
        text: "Magic",
        count: 2,
        path: "kb://v/Lore/Magic",
        candidates: ["kb://v/Lore/Magic", "kb://v/Old/Magic"],
      },
    } as ImportFinding;
    const [first, ...others] = findingSentence(finding).split("\n");
    expect(first).toContain("Knowledge Base / v / Lore / Magic");
    expect(others).toEqual(["Knowledge Base / v / Old / Magic"]);
  });

  it("joins what was kept as written into one sentence and groups findings by section", () => {
    expect(keptAsTextSentence({ callouts: 2, tags: 5, highlights: 0, footnotes: 0 })).toBe(
      "2 callouts and 5 tags",
    );
    expect(findingGroup("properties_unreadable")).toBe("other");
    expect(findingGroup("folder_note")).toBe("renamed");
  });
});
