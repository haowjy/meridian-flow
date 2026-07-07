// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { readLastContextRoute, saveLastContextRoute } from "./context-last-route";

const STORAGE_KEY = "meridian:context-last-route";

describe("context-last-route", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a route per project", () => {
    saveLastContextRoute("p1", { scheme: "manuscript", path: "/arc-1/chapter-1.md" });
    saveLastContextRoute("p2", { scheme: "kb", path: "/notes.md" });
    expect(readLastContextRoute("p1")).toEqual({
      scheme: "manuscript",
      path: "/arc-1/chapter-1.md",
    });
    expect(readLastContextRoute("p2")).toEqual({ scheme: "kb", path: "/notes.md" });
  });

  it("forgets a project when saved null", () => {
    saveLastContextRoute("p1", { scheme: "kb", path: "/notes.md" });
    saveLastContextRoute("p1", null);
    expect(readLastContextRoute("p1")).toBeNull();
  });

  it("drops malformed or unknown-scheme entries instead of throwing", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        good: { scheme: "user", path: "/style.md" },
        badScheme: { scheme: "dropbox", path: "/x.md" },
        badPath: { scheme: "kb", path: "" },
        garbage: 42,
      }),
    );
    expect(readLastContextRoute("good")).toEqual({ scheme: "user", path: "/style.md" });
    expect(readLastContextRoute("badScheme")).toBeNull();
    expect(readLastContextRoute("badPath")).toBeNull();
    expect(readLastContextRoute("garbage")).toBeNull();
  });

  it("survives non-JSON storage content", () => {
    localStorage.setItem(STORAGE_KEY, "not json");
    expect(readLastContextRoute("p1")).toBeNull();
    saveLastContextRoute("p1", { scheme: "kb", path: "/notes.md" });
    expect(readLastContextRoute("p1")).toEqual({ scheme: "kb", path: "/notes.md" });
  });
});
