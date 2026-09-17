/** Slash-activated skills append SKILL.md onto the latest user message. */
import { describe, expect, it } from "vitest";
import { assistant, system, user } from "../gateway/helpers/messages.js";
import { attachSkillBodiesToLatestUserMessage } from "./context-builder.js";

describe("attachSkillBodiesToLatestUserMessage", () => {
  it("appends invoked slug, description, and body as extra user text", () => {
    const later = assistant([{ type: "text", text: "already working" }]);
    const messages = [system("frozen prompt"), user("draft the scene"), later];
    const attached = attachSkillBodiesToLatestUserMessage(messages, [
      {
        slug: "creative-writing-modes",
        description: "Creative-writing addendum to /llm-writing.",
        body: "modes body.",
      },
    ]);
    expect(attached[0]).toEqual(messages[0]);
    expect(attached[1]?.content).toEqual([
      { type: "text", text: "draft the scene" },
      {
        type: "text",
        text: [
          "skill invoked: creative-writing-modes",
          "",
          "description: Creative-writing addendum to /llm-writing.",
          "",
          "modes body.",
        ].join("\n"),
      },
    ]);
    expect(attached).toHaveLength(3);
    expect(attached[2]).toEqual(later);
  });

  it("joins multiple invoked skills onto the same user message", () => {
    const messages = [user("use both")];
    const attached = attachSkillBodiesToLatestUserMessage(messages, [
      { slug: "creative-writing-modes", description: "modes.", body: "modes body." },
      { slug: "writing-principles", description: "principles.", body: "principles body." },
    ]);
    expect(attached[0]?.content).toEqual([
      { type: "text", text: "use both" },
      {
        type: "text",
        text: [
          "skill invoked: creative-writing-modes",
          "",
          "description: modes.",
          "",
          "modes body.",
          "",
          "skill invoked: writing-principles",
          "",
          "description: principles.",
          "",
          "principles body.",
        ].join("\n"),
      },
    ]);
  });

  it("omits an empty description line", () => {
    const attached = attachSkillBodiesToLatestUserMessage(
      [user("/writing-principles")],
      [{ slug: "writing-principles", description: "  ", body: "body" }],
    );
    expect(attached[0]?.content).toEqual([
      { type: "text", text: "/writing-principles" },
      { type: "text", text: "skill invoked: writing-principles\n\nbody" },
    ]);
  });

  it("leaves messages unchanged when no slugs were activated", () => {
    const messages = [system("frozen prompt"), user("hello")];
    expect(attachSkillBodiesToLatestUserMessage(messages, [])).toEqual(messages);
  });

  it("throws when there is no user message to attach to", () => {
    expect(() =>
      attachSkillBodiesToLatestUserMessage(
        [system("frozen prompt")],
        [{ slug: "writing-principles", description: "d", body: "body" }],
      ),
    ).toThrow("Cannot attach skill bodies without a writer message");
  });
});
