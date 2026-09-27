import { afterEach, describe, expect, it } from "vitest";
import { useDockViewStore } from "./dock-view-store";

const tab = (path: string) => ({
  kind: "viewer" as const,
  documentId: `doc-${path}`,
  scheme: "scratch" as const,
  path,
  name: path,
  workId: "work-a",
  editable: false as const,
  fileType: "binary" as const,
});

afterEach(() => useDockViewStore.setState({ byScreen: {}, workFile: null }));

describe("Work dock file view", () => {
  it("opens and replaces the one transient file slot", () => {
    const store = useDockViewStore.getState();
    store.openWorkFile({ workId: "work-a", tab: tab("first.md") });
    expect(useDockViewStore.getState().workFile?.tab.path).toBe("first.md");
    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("second.md") });
    expect(useDockViewStore.getState().workFile?.tab.path).toBe("second.md");
    expect(useDockViewStore.getState().byScreen.work).toBe("file");
  });

  it("closes back to Chat", () => {
    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("first.md") });
    useDockViewStore.getState().closeWorkFile();
    expect(useDockViewStore.getState().workFile).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBe("chat");
  });

  it("clears when navigating to another Work, the collection, or another screen", () => {
    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("first.md") });
    useDockViewStore.getState().syncWorkDestination("work", "work-b");
    expect(useDockViewStore.getState().workFile).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBe("chat");
    useDockViewStore
      .getState()
      .openWorkFile({ workId: "work-b", tab: { ...tab("second.md"), workId: "work-b" } });
    useDockViewStore.getState().syncWorkDestination("work", null);
    expect(useDockViewStore.getState().workFile).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBe("chat");

    useDockViewStore
      .getState()
      .openWorkFile({ workId: "work-b", tab: { ...tab("third.md"), workId: "work-b" } });
    useDockViewStore.getState().syncWorkDestination("chat", null);
    expect(useDockViewStore.getState().workFile).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBe("chat");
  });
});
