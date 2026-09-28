import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import type { RouteWorkResolution } from "./project-route";
import {
  applyContextRepairIfCurrent,
  openContextRouteSearch,
  workDockDestinationId,
} from "./project-route";

describe("Work dock route scope", () => {
  it("uses the resolved or pending Work id and clears for collection and other screens", () => {
    const workId = parseRequestId("f41144a6-1035-460b-9272-6c4712f3a8b6");
    if (!workId) throw new Error("Invalid test Work ID");
    const present: RouteWorkResolution = {
      status: "present",
      workId,
      work: {} as Work,
    };
    expect(workDockDestinationId("work", present)).toBe("f41144a6-1035-460b-9272-6c4712f3a8b6");
    expect(
      workDockDestinationId("work", {
        status: "unresolved",
        reason: "loading",
        slug: "pending-id",
      }),
    ).toBe("pending-id");
    expect(
      workDockDestinationId("work", {
        status: "creating",
        workId,
        name: "Fight scene",
        goal: "Make the turn land",
        phase: "pending",
      }),
    ).toBe(workId);
    expect(workDockDestinationId("work", { status: "none" })).toBeNull();
    expect(workDockDestinationId("chat", present)).toBeNull();
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
