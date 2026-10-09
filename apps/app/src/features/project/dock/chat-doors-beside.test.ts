import { describe, expect, it } from "vitest";
import { opensBesideChat } from "./ChatDocumentsBesideProvider";

describe("where a chat door opens a document", () => {
  it("opens in the dock only when the chat is in the middle on a wide screen", () => {
    expect(opensBesideChat("chat", false)).toBe(true);
    // The chat is the dock on these screens, so a dock document would cover the door's own chat.
    expect(opensBesideChat("context", false)).toBe(false);
    expect(opensBesideChat("work", false)).toBe(false);
    // The phone opens documents full screen.
    expect(opensBesideChat("chat", true)).toBe(false);
  });
});
