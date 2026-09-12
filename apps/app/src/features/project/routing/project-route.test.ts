import { describe, expect, it } from "vitest";
import { applyContextRepairIfCurrent, openContextRouteSearch } from "./project-route";

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

  it("repairs the exact latest search and preserves unrelated params", () => {
    expect(
      applyContextRepairIfCurrent(repair, {
        screen: "context",
        thread: "thread-1",
        scheme: "manuscript",
        path: "/deleted.md",
      }),
    ).toEqual({
      screen: "context",
      thread: "thread-1",
      scheme: "manuscript",
      path: "/next.md",
      work: "none",
    });
  });

  it.each([
    { screen: "home" as const },
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
