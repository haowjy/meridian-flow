import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildWorkingSetRoute, recentRouteForEditorWork } from "./store";

describe("buildWorkingSetRoute", () => {
  it("rejects unresolved authority instead of dropping a Work-capable route", () => {
    expect(() =>
      buildWorkingSetRoute("document-route", "scratch", "/shared.md", undefined),
    ).toThrow("require resolved authority");
  });
});

describe("recentRouteForEditorWork", () => {
  const mixedRoutes: WorkingSetRoute[] = [
    { documentId: "document-route", scheme: "scratch", path: "/shared.md", workId: "work-a" },
    { documentId: "document-route", scheme: "uploads", path: "/shared.pdf", workId: "work-b" },
    { documentId: "document-route", scheme: "manuscript", path: "/chapter.md" },
  ];

  it("accepts only the current Work for Work-scoped routes", () => {
    expect(recentRouteForEditorWork(mixedRoutes, "work-b")).toEqual(mixedRoutes[1]);
    expect(recentRouteForEditorWork(mixedRoutes, "work-a")).toEqual(mixedRoutes[0]);
  });

  it("allows project-scoped routes in every Editor Work", () => {
    expect(recentRouteForEditorWork(mixedRoutes, "work-c")).toEqual(mixedRoutes[2]);
    expect(recentRouteForEditorWork(mixedRoutes, null)).toEqual(mixedRoutes[2]);
  });
});
