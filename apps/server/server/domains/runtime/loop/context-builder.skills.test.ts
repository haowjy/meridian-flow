/** Slash-activated skills inject a request-only `skill` tool round. */
import { describe, expect, it } from "vitest";
import { assistant, system, toolResult, user } from "../gateway/helpers/messages.js";
import { attachSkillBodiesToLatestUserMessage } from "./context-builder.js";

describe("attachSkillBodiesToLatestUserMessage", () => {
  it("inserts a skill tool_use then tool_result after the latest user message", () => {
    const later = assistant([{ type: "text", text: "already working" }]);
    const messages = [system("frozen prompt"), user("draft the scene"), later];
    const attached = attachSkillBodiesToLatestUserMessage(messages, [
      { slug: "creative-writing-modes", body: "modes body." },
    ]);
    expect(attached[0]).toEqual(messages[0]);
    expect(attached[1]).toEqual(messages[1]);
    expect(attached[1]?.content).toEqual([{ type: "text", text: "draft the scene" }]);
    expect(attached[2]).toEqual(
      assistant([
        {
          type: "tool_use",
          toolCallId: "call_skill_creative_writing_modes",
          toolName: "skill",
          input: { slug: "creative-writing-modes" },
        },
      ]),
    );
    expect(attached[3]).toEqual(
      toolResult("call_skill_creative_writing_modes", {
        slug: "creative-writing-modes",
        body: "modes body.",
      }),
    );
    expect(attached[4]).toEqual(later);
  });

  it("emits one tool_use part and one tool_result message per skill", () => {
    const messages = [user("use both")];
    const attached = attachSkillBodiesToLatestUserMessage(messages, [
      { slug: "creative-writing-modes", body: "modes body." },
      { slug: "writing-principles", body: "principles body." },
    ]);
    expect(attached[1]).toEqual(
      assistant([
        {
          type: "tool_use",
          toolCallId: "call_skill_creative_writing_modes",
          toolName: "skill",
          input: { slug: "creative-writing-modes" },
        },
        {
          type: "tool_use",
          toolCallId: "call_skill_writing_principles",
          toolName: "skill",
          input: { slug: "writing-principles" },
        },
      ]),
    );
    expect(attached[2]).toEqual(
      toolResult("call_skill_creative_writing_modes", {
        slug: "creative-writing-modes",
        body: "modes body.",
      }),
    );
    expect(attached[3]).toEqual(
      toolResult("call_skill_writing_principles", {
        slug: "writing-principles",
        body: "principles body.",
      }),
    );
  });

  it("leaves messages unchanged when no slugs were activated", () => {
    const messages = [system("frozen prompt"), user("hello")];
    expect(attachSkillBodiesToLatestUserMessage(messages, [])).toEqual(messages);
  });

  it("throws when there is no user message to attach after", () => {
    expect(() =>
      attachSkillBodiesToLatestUserMessage(
        [system("frozen prompt")],
        [{ slug: "writing-principles", body: "body" }],
      ),
    ).toThrow("Cannot attach skill bodies without a writer message");
  });
});
