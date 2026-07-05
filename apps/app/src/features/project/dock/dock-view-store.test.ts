import { describe, expect, it } from "vitest";

import { resolveDockView } from "./dock-view-store";

describe("resolveDockView", () => {
  it("defaults to each screen's native occupant view", () => {
    expect(resolveDockView("chat", undefined).view).toBe("context");
    expect(resolveDockView("context", undefined).view).toBe("chat");
    expect(resolveDockView("home", undefined).view).toBe("chat");
  });

  it("honors a stored choice that is valid for the screen's set", () => {
    expect(resolveDockView("chat", "changes").view).toBe("changes");
    expect(resolveDockView("context", "changes").view).toBe("changes");
  });

  it("falls back to the default when the stored choice is not in the screen's set", () => {
    // Chat is the center pane on the chat screen — never a dock view there.
    expect(resolveDockView("chat", "chat").view).toBe("context");
    // Context is the center pane on the context screen — never a dock view there.
    expect(resolveDockView("context", "context").view).toBe("chat");
  });

  it("exposes the ordered set and the primary (non-Changes) view", () => {
    expect(resolveDockView("chat", undefined).views).toEqual(["context", "changes"]);
    expect(resolveDockView("chat", undefined).primaryView).toBe("context");
    expect(resolveDockView("context", undefined).primaryView).toBe("chat");
  });
});
