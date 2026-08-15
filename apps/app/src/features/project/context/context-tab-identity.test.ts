import { describe, expect, it } from "vitest";
import { contextTabRouteKey } from "./context-tab-identity";

describe("context tab route identity", () => {
  it("qualifies the same Scratch and Uploads paths by Work", () => {
    expect(contextTabRouteKey("project", "scratch", "/same.md", "work-a")).not.toBe(
      contextTabRouteKey("project", "scratch", "/same.md", "work-b"),
    );
    expect(contextTabRouteKey("project", "uploads", "/same.pdf", "work-a")).not.toBe(
      contextTabRouteKey("project", "uploads", "/same.pdf", "work-b"),
    );
  });

  it("keeps project document identity independent of Work", () => {
    expect(contextTabRouteKey("project", "manuscript", "/same.md", "work-a")).toBe(
      contextTabRouteKey("project", "manuscript", "/same.md", "work-b"),
    );
  });
});
