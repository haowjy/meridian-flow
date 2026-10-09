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

afterEach(() => useDockViewStore.setState({ workFile: null }));

describe("Work dock file view", () => {
  it("docks one view per screen and adds File only on Work while a Work file exists", () => {
    expect(resolveDockView("work", false)).toEqual({ view: "chat", views: ["chat"] });
    expect(resolveDockView("work", true)).toEqual({ view: "chat", views: ["chat", "file"] });
    // The Chat screen docks the context rail; the Editor docks the chat. Neither has a switch.
    expect(resolveDockView("chat", false)).toEqual({ view: "context", views: ["context"] });
    expect(resolveDockView("chat", true)).toEqual({ view: "context", views: ["context"] });
    expect(resolveDockView("context", false)).toEqual({ view: "chat", views: ["chat"] });
  });

  it("opens, replaces, leaves, revisits, and closes the transient file slot", () => {
    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("first.md") });
    expect(useDockViewStore.getState().workFile).toMatchObject({
      workId: "work-a",
      tab: { path: "first.md" },
      active: true,
    });

    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("second.md") });
    expect(useDockViewStore.getState().workFile?.tab.path).toBe("second.md");
    useDockViewStore.getState().setDockView("work", "chat");
    expect(useDockViewStore.getState().workFile).toMatchObject({ active: false });
    useDockViewStore.getState().setDockView("work", "file");
    expect(useDockViewStore.getState().workFile).toMatchObject({ active: true });

    useDockViewStore.getState().closeWorkFile();
    expect(useDockViewStore.getState().workFile).toBeNull();
  });

  it("shows the file only on Work, and only while there is one", () => {
    useDockViewStore.getState().setDockView("work", "file");
    expect(useDockViewStore.getState().workFile).toBeNull();
    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("first.md") });
    useDockViewStore.getState().setDockView("context", "file");
    expect(useDockViewStore.getState().workFile).toMatchObject({ active: true });
    useDockViewStore.getState().setDockView("context", "chat");
    expect(useDockViewStore.getState().workFile).toMatchObject({ active: true });
  });

  it("clears the slot when entering another Work or leaving the Work destination", () => {
    useDockViewStore.getState().openWorkFile({ workId: "work-a", tab: tab("first.md") });
    useDockViewStore.getState().enterWork("work-a");
    expect(useDockViewStore.getState().workFile?.tab.path).toBe("first.md");

    useDockViewStore.getState().enterWork("work-b");
    expect(useDockViewStore.getState().workFile).toBeNull();

    useDockViewStore.getState().openWorkFile({ workId: "work-b", tab: tab("second.md") });
    useDockViewStore.getState().leaveWork();
    expect(useDockViewStore.getState().workFile).toBeNull();
  });
});
