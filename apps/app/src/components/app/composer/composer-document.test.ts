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
    expect(envelope.text).toBe("hello");
    expect(envelope.blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("keeps an empty slug list when none were picked", () => {
    expect(serializeComposerDraft(plainComposerDoc("hello")).activatedSkillSlugs).toEqual([]);
  });

  it("does not treat skill atoms as message content", () => {
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
    expect(envelope.text).toBe("");
    expect(envelope.blocks).toEqual([]);
    expect(envelope.references).toEqual([]);
  });
});
