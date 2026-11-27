import { describe, expect, it } from "vitest";
import { hashPromptBakeContent } from "./prompt-bake-hash.js";

describe("hashPromptBakeContent", () => {
  it("changes when only the connections' pins change", () => {
    const content = {
      composedSystemPrompt: "prompt",
      bakedSkillSlugs: [],
      bakedTools: [],
      bakedConnections: [
        { name: "notes", connectionId: "c1", pinId: "p1", listing: "full" as const },
      ],
    };
    const repinned = {
      ...content,
      bakedConnections: [{ ...content.bakedConnections[0]!, pinId: "p2" }],
    };
    expect(hashPromptBakeContent(repinned)).not.toBe(hashPromptBakeContent(content));
  });
});
