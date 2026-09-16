import { describe, expect, it } from "vitest";

import { plainComposerDoc, serializeComposerDraft } from "./composer-document";

describe("serializeComposerDraft skill slugs", () => {
  it("includes picked slugs on the envelope", () => {
    const envelope = serializeComposerDraft(plainComposerDoc("hello"), 0, { anchor: 1, head: 1 }, [
      "creative-writing-modes",
      "writing-principles",
    ]);
    expect(envelope.activatedSkillSlugs).toEqual(["creative-writing-modes", "writing-principles"]);
    expect(envelope.text).toBe("hello");
  });

  it("keeps an empty slug list when none were picked", () => {
    expect(serializeComposerDraft(plainComposerDoc("hello")).activatedSkillSlugs).toEqual([]);
  });
});
