/** Chat verbs in the `/` catalog: listed once, as verbs, never as skills. */
import { describe, expect, it } from "vitest";
import {
  composerChatCommandItems,
  composerSkillCommandItems,
  filterComposerCommandItems,
  matchComposerChatCommand,
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

describe("typed chat verbs", () => {
  const compact = {
    slug: "compact",
    name: "Compact conversation",
    description: "d",
    run: () => undefined,
  } as const;
  const match = (text: string) => {
    const found = matchComposerChatCommand(text, [compact]);
    return found ? found.instructions : "message";
  };

  it("takes the rest of the draft as trimmed instructions; empty is none", () => {
    expect(match("/compact")).toBeNull();
    expect(match("  /compact   ")).toBeNull();
    expect(match("/compact Keep the sect names")).toBe("Keep the sect names");
    expect(match("/compact\nKeep the oath\n\nand the debts ")).toBe(
      "Keep the oath\n\nand the debts",
    );
  });

  it("leaves everything else as a message", () => {
    expect(match("/compactly")).toBe("message");
    expect(match("please /compact")).toBe("message");
    expect(match("/handoff now")).toBe("message");
    expect(matchComposerChatCommand("/compact", [])).toBeNull();
  });
});
