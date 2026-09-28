/** Chat verbs in the `/` catalog: listed once, as verbs, never as skills. */
import { describe, expect, it } from "vitest";
import {
  composerChatCommandItems,
  composerSkillCommandItems,
  filterComposerCommandItems,
} from "./command-catalog";

describe("composer chat verbs", () => {
  it("lists /compact once, as a chat verb, never as a skill", () => {
    const items = [
      ...composerSkillCommandItems([
        { slug: "compact", name: "Shadow", description: "a skill may not take a verb" },
        { slug: "critique", name: "Critique", description: "Read critically" },
      ]),
      ...composerChatCommandItems([
        { slug: "compact", name: "Compact conversation", description: "d", run: () => undefined },
      ]),
    ];
    expect(items.map(({ kind, group, slug }) => ({ kind, group, slug }))).toEqual([
      { kind: "skill", group: "skills", slug: "critique" },
      { kind: "command", group: "chat", slug: "compact" },
    ]);
    expect(filterComposerCommandItems(items, "comp")[0]?.slug).toBe("compact");
  });
});
