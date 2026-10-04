import { describe, expect, it } from "vitest";
import { assembleComposedSystemPrompt } from "./composed-system-prompt.js";

describe("assembleComposedSystemPrompt", () => {
  it("lists available skills by their SKILL.md URIs in the frozen bytes", () => {
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
    expect(prompt).toContain(
      [
        "You are Writer.",
        "",
        "Available skills",
        "Read a skill's SKILL.md before doing work it covers. Paths in a skill are relative to its folder.",
        "",
        "skills://creative-writing-modes/SKILL.md",
        "Modes for putting prose on the page.",
        "",
        "skills://writing-principles/SKILL.md",
        "Reader reward and LLM fiction failure modes.",
      ].join("\n"),
    );
  });

  it("names the skill after its URI when the name differs from the slug", () => {
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
    expect(prompt).toContain(
      "skills://story-review/SKILL.md (Story Review)\nReview drafts after prose exists.",
    );
    expect(prompt).not.toContain("\nStory Review\n");
  });

  it("heads a preloaded skill's body with its SKILL.md URI", () => {
    const prompt = assembleComposedSystemPrompt({
      basePrompt: "You are Critic.",
      preloadedSkills: [
        {
          slug: "story-review",
          description: "Review drafts.",
          body: "Review body.\n",
          readable: true,
        },
      ],
    });
    expect(prompt).toContain(
      "skill invoked: skills://story-review/SKILL.md\n\ndescription: Review drafts.\n\nReview body.\n",
    );
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
