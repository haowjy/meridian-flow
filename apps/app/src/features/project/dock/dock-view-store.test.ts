/** Dock destinations available on each project screen. */
import { describe, expect, it } from "vitest";

import { resolveDockView } from "./dock-view-store";

describe("resolveDockView", () => {
  it("gives Work the same Chat and Changes dock as Home", () => {
    expect(resolveDockView("work", undefined)).toEqual(resolveDockView("home", undefined));
    expect(resolveDockView("work", "context")).toMatchObject({
      view: "chat",
      views: ["chat", "changes"],
    });
  });
});
