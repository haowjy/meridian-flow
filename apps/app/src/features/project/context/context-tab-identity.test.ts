import { describe, expect, it } from "vitest";
import { contextTabRouteKey } from "./context-tab-identity";

const target = (
  scheme: "scratch" | "uploads" | "manuscript",
  workId: string,
  rootThreadId?: string,
) => ({ scheme, path: "/same.md", workId, rootThreadId });

describe("context tab route identity", () => {
  it("qualifies the same Scratch and Uploads paths by Work", () => {
    expect(contextTabRouteKey("project", target("scratch", "work-a"))).not.toBe(
      contextTabRouteKey("project", target("scratch", "work-b")),
    );
    expect(contextTabRouteKey("project", target("uploads", "work-a"))).not.toBe(
      contextTabRouteKey("project", target("uploads", "work-b")),
    );
  });

  it("keeps project document identity independent of Work", () => {
    expect(contextTabRouteKey("project", target("manuscript", "work-a"))).toBe(
      contextTabRouteKey("project", target("manuscript", "work-b")),
    );
  });

  it("qualifies a chat's Scratch by its lineage, not by the Editor's Work", () => {
    expect(contextTabRouteKey("project", target("scratch", "work-a", "chat-1"))).toBe(
      contextTabRouteKey("project", target("scratch", "work-b", "chat-1")),
    );
    expect(contextTabRouteKey("project", target("scratch", "work-a", "chat-1"))).not.toBe(
      contextTabRouteKey("project", target("scratch", "work-a", "chat-2")),
    );
    expect(contextTabRouteKey("project", target("scratch", "work-a", "chat-1"))).not.toBe(
      contextTabRouteKey("project", target("scratch", "work-a")),
    );
  });
});
