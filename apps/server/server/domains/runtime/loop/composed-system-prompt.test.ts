import { describe, expect, it } from "vitest";
import { assembleComposedSystemPrompt } from "./composed-system-prompt.js";

describe("assembleComposedSystemPrompt", () => {
  it("joins available skill slugs and descriptions into the frozen bytes", () => {
    const prompt = assembleComposedSystemPrompt({
      basePrompt: "You are Writer.",
      availableSkills: [
        {
          slug: "creative-writing-modes",
          name: "creative-writing-modes",
          description: "Modes for putting prose on the page.",
        },
        {
          slug: "writing-principles",
          name: "writing-principles",
          description: "Reader reward and LLM fiction failure modes.",
        },
      ],
    });
    expect(prompt.startsWith("You are Writer.\n\nAvailable skills\n\n")).toBe(true);
    expect(prompt).toContain("creative-writing-modes\nModes for putting prose on the page.");
    expect(prompt).toContain("writing-principles\nReader reward and LLM fiction failure modes.");
  });

  it("lists slug as identity and name when they differ", () => {
    const prompt = assembleComposedSystemPrompt({
      basePrompt: "You are Writer.",
      availableSkills: [
        {
          slug: "story-review",
          name: "Story Review",
          description: "Review drafts after prose exists.",
        },
      ],
    });
    expect(prompt).toContain("story-review (Story Review)\nReview drafts after prose exists.");
    expect(prompt).not.toContain("\nStory Review\n");
  });

  it("omits the available-skills section when no skills are listed", () => {
    const withSkills = assembleComposedSystemPrompt({
      basePrompt: "You are Writer.",
      availableSkills: [
        { slug: "creative-writing-modes", name: "creative-writing-modes", description: "Modes." },
      ],
    });
    const empty = assembleComposedSystemPrompt({
      basePrompt: "You are Writer.",
      availableSkills: [],
    });
    expect(withSkills).toContain("Available skills");
    expect(empty).not.toContain("Available skills");
  });

  it("joins named subagent slugs and descriptions into the frozen bytes", () => {
    const prompt = assembleComposedSystemPrompt({
      basePrompt: "You are Muse.",
      namedSubagents: [
        {
          slug: "critic",
          name: "critic",
          description: "Adversarial craft critique.",
        },
        {
          slug: "writer-helper",
          name: "Writer Helper",
          description: "Fast draft variants.",
        },
      ],
    });
    expect(prompt).toContain("Named subagents\n\ncritic\nAdversarial craft critique.");
    expect(prompt).toContain("writer-helper (Writer Helper)\nFast draft variants.");
  });

  it("omits the named-subagents section when the roster is empty", () => {
    const withRoster = assembleComposedSystemPrompt({
      basePrompt: "You are Muse.",
      namedSubagents: [{ slug: "critic", name: "critic", description: "Critique." }],
    });
    const empty = assembleComposedSystemPrompt({
      basePrompt: "You are Muse.",
      namedSubagents: [],
    });
    expect(withRoster).toContain("Named subagents");
    expect(empty).not.toContain("Named subagents");
  });
});
