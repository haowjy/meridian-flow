/**
 * Unit tests for composed system prompt assembly and freeze detection.
 */
import { describe, expect, it } from "vitest";
import { SKILLS_CATALOG_PROMPT_MARKER } from "../../tools/skill-tools.js";
import {
  assembleComposedSystemPrompt,
  bakedSkillSetAdvertisesInvoke,
  isThreadPromptFrozen,
  rebakeComposedSystemPrompt,
} from "../composed-system-prompt.js";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "../context-builder.js";

describe("composed-system-prompt", () => {
  it("assembles base prompt, skills section, and URI guidance", () => {
    const composed = assembleComposedSystemPrompt({
      basePrompt: "Agent body.",
      skillsSystemPromptSection: `---\n${SKILLS_CATALOG_PROMPT_MARKER}\n- skill-one: Run\n---`,
    });
    expect(composed).toContain("Agent body.");
    expect(composed).toContain(SKILLS_CATALOG_PROMPT_MARKER);
    expect(composed).toContain(RUNTIME_URI_SYSTEM_INSTRUCTION);
    expect(bakedSkillSetAdvertisesInvoke(["skill-one"])).toBe(true);
  });

  it("derives invoke advertisement from non-empty baked slug sets", () => {
    expect(bakedSkillSetAdvertisesInvoke([])).toBe(false);
    expect(bakedSkillSetAdvertisesInvoke(null)).toBe(false);
    expect(bakedSkillSetAdvertisesInvoke(["alpha"])).toBe(true);
  });

  it("treats persisted bakedSkillSlugs as the freeze sentinel", () => {
    expect(isThreadPromptFrozen({ bakedSkillSlugs: null })).toBe(false);
    expect(isThreadPromptFrozen({ bakedSkillSlugs: undefined })).toBe(false);
    expect(isThreadPromptFrozen({ bakedSkillSlugs: [] })).toBe(true);
    expect(isThreadPromptFrozen({ bakedSkillSlugs: ["skill-one"] })).toBe(true);
  });

  it("rebakes from base prompt and skills section", () => {
    expect(
      rebakeComposedSystemPrompt({
        basePrompt: "Agent body.",
        skillsSystemPromptSection: "skills",
      }),
    ).toBe(
      assembleComposedSystemPrompt({
        basePrompt: "Agent body.",
        skillsSystemPromptSection: "skills",
      }),
    );
  });
});
