import { describe, expect, it } from "vitest";
import { assembleComposedSystemPrompt } from "./composed-system-prompt.js";

describe("assembleComposedSystemPrompt", () => {
  it("joins available skill names and descriptions into the frozen bytes", () => {
    const prompt = assembleComposedSystemPrompt({
      basePrompt: "You are Writer.",
      availableSkills: [
        {
          name: "creative-writing-modes",
          description: "Modes for putting prose on the page.",
        },
        {
          name: "writing-principles",
          description: "Reader reward and LLM fiction failure modes.",
        },
      ],
    });
    expect(prompt.startsWith("You are Writer.\n\nAvailable skills\n\n")).toBe(true);
    expect(prompt).toContain("creative-writing-modes\nModes for putting prose on the page.");
    expect(prompt).toContain("writing-principles\nReader reward and LLM fiction failure modes.");
  });

  it("omits the available-skills section when the union is empty", () => {
    const withSkills = assembleComposedSystemPrompt({
      basePrompt: "You are Writer.",
      availableSkills: [{ name: "creative-writing-modes", description: "Modes." }],
    });
    const empty = assembleComposedSystemPrompt({
      basePrompt: "You are Writer.",
      availableSkills: [],
    });
    expect(withSkills).toContain("Available skills");
    expect(empty).not.toContain("Available skills");
  });
});
