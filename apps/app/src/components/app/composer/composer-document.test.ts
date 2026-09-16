import { describe, expect, it } from "vitest";

import { plainComposerDoc, serializeComposerDraft } from "./composer-document";

const skill = (slug: string, name = slug) => ({
  type: "composerSkill",
  attrs: { slug, name, description: `${name} body` },
});

describe("serializeComposerDraft skill slugs", () => {
  it("reads unique slugs from skill atoms in document order", () => {
    const envelope = serializeComposerDraft({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hello" },
            skill("creative-writing-modes", "Creative writing modes"),
            skill("writing-principles", "Writing principles"),
            skill("creative-writing-modes", "Creative writing modes"),
          ],
        },
      ],
    });
    expect(envelope.activatedSkillSlugs).toEqual(["creative-writing-modes", "writing-principles"]);
    expect(envelope.text).toBe(
      "hello/creative-writing-modes/writing-principles/creative-writing-modes",
    );
    expect(envelope.blocks).toEqual([
      { type: "text", text: "hello" },
      {
        type: "skill",
        text: "/creative-writing-modes",
        slug: "creative-writing-modes",
        name: "Creative writing modes",
        description: "Creative writing modes body",
      },
      {
        type: "skill",
        text: "/writing-principles",
        slug: "writing-principles",
        name: "Writing principles",
        description: "Writing principles body",
      },
      {
        type: "skill",
        text: "/creative-writing-modes",
        slug: "creative-writing-modes",
        name: "Creative writing modes",
        description: "Creative writing modes body",
      },
    ]);
  });

  it("keeps an empty slug list when none were picked", () => {
    expect(serializeComposerDraft(plainComposerDoc("hello")).activatedSkillSlugs).toEqual([]);
  });

  it("puts /slug into the submitted message so the transcript can show it", () => {
    const envelope = serializeComposerDraft({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [skill("writing-principles", "Writing principles")],
        },
      ],
    });
    expect(envelope.activatedSkillSlugs).toEqual(["writing-principles"]);
    expect(envelope.text).toBe("/writing-principles");
    expect(envelope.blocks).toEqual([
      {
        type: "skill",
        text: "/writing-principles",
        slug: "writing-principles",
        name: "Writing principles",
        description: "Writing principles body",
      },
    ]);
    expect(envelope.references).toEqual([]);
  });
});
