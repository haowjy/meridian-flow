import { afterEach, describe, expect, it } from "vitest";
import { resolveDockView, useDockViewStore } from "./dock-view-store";

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
  it("resolves per-screen defaults and adds File only while a Work file exists", () => {
    expect(resolveDockView("work", undefined, false)).toEqual({
      view: "chat",
      views: ["chat", "changes"],
      primaryView: "chat",
    });
    expect(resolveDockView("work", "context", true)).toEqual({
      view: "chat",
      views: ["chat", "file", "changes"],
      primaryView: "chat",
    });
    expect(resolveDockView("chat", "chat", true)).toEqual({
      view: "context",
      views: ["context", "changes"],
      primaryView: "context",
    });
  });

  it("opens, replaces, leaves, revisits, and closes the transient file slot", () => {
    const store = useDockViewStore.getState();
    store.setDockView("work", "changes");
    store.openWorkFile({ workId: "work-a", tab: tab("first.md") });
    expect(useDockViewStore.getState().workFile).toMatchObject({
      workId: "work-a",
      tab: { path: "first.md" },
      active: true,
    });
    expect(useDockViewStore.getState().byScreen.work).toBe("changes");

    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("second.md") });
    expect(useDockViewStore.getState().workFile?.tab.path).toBe("second.md");
    useDockViewStore.getState().setDockView("work", "chat");
    expect(useDockViewStore.getState().workFile).toMatchObject({ active: false });
    useDockViewStore.getState().setDockView("work", "file");
    expect(useDockViewStore.getState().workFile).toMatchObject({ active: true });

    useDockViewStore.getState().closeWorkFile();
    const state = useDockViewStore.getState();
    expect(state.workFile).toBeNull();
    expect(state.byScreen.work).toBe("chat");
  });

  it("clears the slot when entering another Work or leaving the Work destination", () => {
    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("first.md") });
    useDockViewStore.getState().enterWork("work-a");
    expect(useDockViewStore.getState().workFile?.tab.path).toBe("first.md");

    useDockViewStore.getState().enterWork("work-b");
    expect(useDockViewStore.getState().workFile).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBeUndefined();

    useDockViewStore.getState().openWorkFile({ workId: "work-b", tab: tab("second.md") });
    useDockViewStore.getState().leaveWork();
    expect(useDockViewStore.getState().workFile).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBeUndefined();
  });
});
