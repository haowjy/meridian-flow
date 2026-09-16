/** Current-turn skill body attachment stays on the user message. */
import { describe, expect, it } from "vitest";
import { system, user } from "../gateway/helpers/messages.js";
import { attachSkillBodiesToLatestUserMessage } from "./context-builder.js";

describe("attachSkillBodiesToLatestUserMessage", () => {
  it("appends loaded bodies to the latest user message", () => {
    const messages = [system("frozen prompt"), user("draft the scene")];
    const attached = attachSkillBodiesToLatestUserMessage(messages, [
      { slug: "creative-writing-modes", body: "modes body." },
    ]);
    expect(attached[0]).toEqual(messages[0]);
    expect(attached[1]?.content[0]).toEqual({ type: "text", text: "draft the scene" });
    expect(attached[1]?.content[1]).toMatchObject({
      type: "text",
      text: "\n\nLoaded skill creative-writing-modes:\nmodes body.",
    });
  });

  it("leaves messages unchanged when no slugs were activated", () => {
    const messages = [system("frozen prompt"), user("hello")];
    expect(attachSkillBodiesToLatestUserMessage(messages, [])).toEqual(messages);
  });
});
