/** Slash-activated skills append SKILL.md onto the latest user message. */
import { describe, expect, it } from "vitest";
import { assistant, system, user } from "../gateway/helpers/messages.js";
import { attachSkillBodiesToLatestUserMessage } from "./context-builder.js";

describe("attachSkillBodiesToLatestUserMessage", () => {
  it("appends skill bodies to the latest user message without changing earlier ones", () => {
    const later = assistant([{ type: "text", text: "already working" }]);
    const messages = [system("frozen prompt"), user("draft the scene"), later];
    const attached = attachSkillBodiesToLatestUserMessage(messages, [
      { slug: "creative-writing-modes", body: "modes body." },
    ]);
    expect(attached[0]).toEqual(messages[0]);
    expect(attached[1]?.content).toEqual([
      { type: "text", text: "draft the scene" },
      { type: "text", text: "Loaded skill creative-writing-modes:\nmodes body." },
    ]);
    expect(attached).toHaveLength(3);
    expect(attached[2]).toEqual(later);
  });

  it("joins multiple skill bodies onto the same user message", () => {
    const messages = [user("use both")];
    const attached = attachSkillBodiesToLatestUserMessage(messages, [
      { slug: "creative-writing-modes", body: "modes body." },
      { slug: "writing-principles", body: "principles body." },
    ]);
    expect(attached[0]?.content).toEqual([
      { type: "text", text: "use both" },
      {
        type: "text",
        text: "Loaded skill creative-writing-modes:\nmodes body.\n\nLoaded skill writing-principles:\nprinciples body.",
      },
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
        [{ slug: "writing-principles", body: "body" }],
      ),
    ).toThrow("Cannot attach skill bodies without a writer message");
  });
});
