import { beforeEach, describe, expect, it } from "vitest";
import { useContextTabsStore } from "./context-tabs-store";

describe("context tabs draft-only lifecycle", () => {
  beforeEach(() => {
    useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
  });

  it("clears the draft-only marker when a live tree tab refreshes the document", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", trackedTab(true));
    store.openTab("project-1", trackedTab(false));

    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([
      trackedTab(false),
    ]);
  });
});

function trackedTab(draftOnly: boolean) {
  return {
    kind: "tracked" as const,
    documentId: "document-1",
    scheme: "manuscript" as const,
    path: "/chapter.md",
    name: "chapter.md",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
    ...(draftOnly ? { draftOnly: true } : {}),
  };
}
