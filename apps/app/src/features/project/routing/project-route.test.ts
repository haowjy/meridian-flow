import { parseRequestId } from "@meridian/contracts/request-id";
import { describe, expect, it } from "vitest";
import type { AddressableWork } from "@/client/query/useWorks";
import { applyContextRepairIfCurrent, openContextRouteSearch, routeWorkId } from "./project-route";

describe("route Work identity", () => {
  it("names the present, creating or unresolved Work, and nothing else", () => {
    const workId = parseRequestId("f41144a6-1035-460b-9272-6c4712f3a8b6");
    if (!workId) throw new Error("Invalid test Work ID");
    expect(routeWorkId({ status: "present", workId, work: {} as AddressableWork })).toBe(workId);
    expect(routeWorkId({ status: "unresolved", reason: "loading", workId })).toBe(workId);
    expect(routeWorkId({ status: "unresolved", reason: "unavailable", workId: null })).toBeNull();
    expect(
      routeWorkId({
        status: "creating",
        workId,
        name: "Fight scene",
        goal: "Make the turn land",
        phase: "pending",
      }),
    ).toBe(workId);
    expect(routeWorkId({ status: "none" })).toBeNull();
    expect(routeWorkId({ status: "new" })).toBeNull();
  });
});

describe("guarded context route repair", () => {
  const repair = {
    expectedSearch: {
      screen: "context" as const,
      work: undefined,
      scheme: "manuscript" as const,
      path: "/deleted.md",
    },
    expectedSelection: { kind: "removed-binding" as const, revision: 4, documentId: "document-a" },
    next: { scheme: "manuscript" as const, path: "/next.md", workId: null },
  };

  it("repairs the exact latest search", () => {
    expect(
      applyContextRepairIfCurrent(repair, {
        screen: "context",
        scheme: "manuscript",
        path: "/deleted.md",
      }),
    ).toEqual({
      screen: "context",
      scheme: "manuscript",
      path: "/next.md",
      work: "none",
    });
  });

  it.each([
    { screen: "chat" as const },
    { screen: "context" as const, scheme: "manuscript" as const, path: "/newer.md" },
  ])("lets newer navigation defeat delayed repair", (latest) => {
    expect(applyContextRepairIfCurrent(repair, latest)).toEqual(latest);
  });
});

describe("context route command", () => {
  it("updates Work, scheme, folder, path, and Results as one transition", () => {
    expect(
      openContextRouteSearch(
        {
          screen: "context",
          work: "work-b",
          scheme: "scratch",
          folder: "/old",
          path: "/old/file.md",
          results: "",
        },
        { scheme: "manuscript", path: "/Act Two/Arrival.md", workId: "work-a" },
      ),
    ).toEqual({
      screen: "context",
      work: "work-a",
      scheme: "manuscript",
      folder: "/Act Two",
      path: "/Act Two/Arrival.md",
    });
  });
});
