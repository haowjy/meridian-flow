import { afterEach, describe, expect, it } from "vitest";
import { type DockOccupant, useDockViewStore } from "./dock-view-store";

const tab = (path: string, workId = "work-a") => ({
  kind: "viewer" as const,
  documentId: `doc-${path}`,
  scheme: "scratch" as const,
  path,
  name: path,
  workId,
  editable: false as const,
  fileType: "binary" as const,
});

const document = (
  path: string,
  screen: "work" | "chat" = "work",
  projectId = "project-a",
): DockOccupant => ({ kind: "document", projectId, screen, tab: tab(path) });

const result = (projectId = "project-a"): DockOccupant => ({
  kind: "result",
  projectId,
  screen: "chat",
  result: { id: "result-1" } as Extract<DockOccupant, { kind: "result" }>["result"],
});

const path = () => {
  const { occupant } = useDockViewStore.getState();
  return occupant?.kind === "document" ? occupant.tab.path : null;
};

afterEach(() => useDockViewStore.setState({ byScreen: {}, occupant: null, revision: 0 }));

describe("dock occupant", () => {
  it("opens, replaces, and closes without disturbing the writer's view choice", () => {
    const store = useDockViewStore.getState();
    store.setDockView("work", "changes");
    store.open(document("first.md"));
    store.open(document("second.md"));
    expect(path()).toBe("second.md");
    expect(useDockViewStore.getState().byScreen.work).toBe("changes");

    useDockViewStore.getState().closeDocument();
    expect(useDockViewStore.getState().occupant).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBe("changes");
  });

  it("is replaced when the writer picks a view on its screen, not on another", () => {
    useDockViewStore.getState().open(document("first.md"));
    useDockViewStore.getState().setDockView("chat", "context");
    expect(useDockViewStore.getState().occupant).not.toBeNull();

    useDockViewStore.getState().setDockView("work", "chat");
    expect(useDockViewStore.getState().occupant).toBeNull();
  });

  it("drops a Work note when the Work or screen changes, and keeps a Chat occupant on the Chat screen", () => {
    const store = useDockViewStore.getState();
    store.open(document("first.md"));
    store.syncOccupantScope("project-a", "work", "work-a");
    expect(useDockViewStore.getState().occupant).not.toBeNull();
    store.syncOccupantScope("project-a", "work", "work-b");
    expect(useDockViewStore.getState().occupant).toBeNull();

    store.open(document("first.md"));
    store.syncOccupantScope("project-a", "context", null);
    expect(useDockViewStore.getState().occupant).toBeNull();

    store.open(document("first.md", "chat"));
    store.syncOccupantScope("project-a", "chat", null);
    expect(useDockViewStore.getState().occupant).not.toBeNull();
    store.open(result());
    store.syncOccupantScope("project-a", "chat", null);
    expect(useDockViewStore.getState().occupant?.kind).toBe("result");
    store.syncOccupantScope("project-a", "work", "work-a");
    expect(useDockViewStore.getState().occupant).toBeNull();
  });

  it("is cleared when the project changes, a result included", () => {
    useDockViewStore.getState().open(result("project-a"));
    useDockViewStore.getState().syncOccupantScope("project-b", "chat", null);
    expect(useDockViewStore.getState().occupant).toBeNull();

    useDockViewStore.getState().open(document("first.md", "chat", "project-a"));
    useDockViewStore.getState().syncOccupantScope("project-b", "chat", null);
    expect(useDockViewStore.getState().occupant).toBeNull();
  });

  it("bumps its revision on every change, so a slow open can tell it was overtaken", () => {
    const revision = () => useDockViewStore.getState().revision;
    const start = revision();
    useDockViewStore.getState().open(document("first.md", "chat"));
    useDockViewStore.getState().syncOccupantScope("project-a", "chat", null);
    expect(revision()).toBe(start + 1);

    useDockViewStore.getState().open(result());
    useDockViewStore.getState().closeDocument();
    useDockViewStore.getState().syncOccupantScope("project-b", "chat", null);
    expect(revision()).toBe(start + 3);
  });
});
