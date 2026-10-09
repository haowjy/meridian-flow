import { afterEach, describe, expect, it } from "vitest";
import { useDockViewStore } from "./dock-view-store";

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

afterEach(() => useDockViewStore.setState({ byScreen: {}, document: null, result: null }));

describe("dock document slot", () => {
  it("opens, replaces, and closes without disturbing the writer's view choice", () => {
    const store = useDockViewStore.getState();
    store.setDockView("work", "changes");
    store.openDocument({ screen: "work", tab: tab("first.md") });
    store.openDocument({ screen: "work", tab: tab("second.md") });
    expect(useDockViewStore.getState().document?.tab.path).toBe("second.md");
    expect(useDockViewStore.getState().byScreen.work).toBe("changes");

    useDockViewStore.getState().closeDocument();
    expect(useDockViewStore.getState().document).toBeNull();
    expect(useDockViewStore.getState().byScreen.work).toBe("changes");
  });

  it("is replaced when the writer picks a view on its screen, not on another", () => {
    useDockViewStore.getState().openDocument({ screen: "work", tab: tab("first.md") });
    useDockViewStore.getState().setDockView("chat", "context");
    expect(useDockViewStore.getState().document).not.toBeNull();

    useDockViewStore.getState().setDockView("work", "chat");
    expect(useDockViewStore.getState().document).toBeNull();
  });

  it("drops a Work note when the Work or screen changes, and keeps a Chat note on the Chat screen", () => {
    const store = useDockViewStore.getState();
    store.openDocument({ screen: "work", tab: tab("first.md") });
    store.syncDocumentScope("work", "work-a");
    expect(useDockViewStore.getState().document).not.toBeNull();
    store.syncDocumentScope("work", "work-b");
    expect(useDockViewStore.getState().document).toBeNull();

    store.openDocument({ screen: "work", tab: tab("first.md") });
    store.syncDocumentScope("context", null);
    expect(useDockViewStore.getState().document).toBeNull();

    store.openDocument({ screen: "chat", tab: tab("note.md") });
    store.syncDocumentScope("chat", null);
    expect(useDockViewStore.getState().document).not.toBeNull();
    store.syncDocumentScope("work", "work-a");
    expect(useDockViewStore.getState().document).toBeNull();
  });
});

describe("dock result slot", () => {
  const result = { id: "result-1" } as Parameters<
    ReturnType<typeof useDockViewStore.getState>["openResult"]
  >[0];

  it("shares one slot with the document and closes with it", () => {
    const store = useDockViewStore.getState();
    store.openDocument({ screen: "chat", tab: tab("first.md") });
    store.openResult(result);
    expect(useDockViewStore.getState()).toMatchObject({ document: null, result });

    useDockViewStore.getState().openDocument({ screen: "chat", tab: tab("second.md") });
    expect(useDockViewStore.getState().result).toBeNull();

    useDockViewStore.getState().openResult(result);
    useDockViewStore.getState().closeDocument();
    expect(useDockViewStore.getState()).toMatchObject({ document: null, result: null });
  });

  it("belongs to the Chat screen's rail only", () => {
    useDockViewStore.getState().openResult(result);
    useDockViewStore.getState().syncDocumentScope("chat", null);
    expect(useDockViewStore.getState().result).toBe(result);

    useDockViewStore.getState().syncDocumentScope("work", "work-a");
    expect(useDockViewStore.getState().result).toBeNull();

    useDockViewStore.getState().openResult(result);
    useDockViewStore.getState().setDockView("chat", "changes");
    expect(useDockViewStore.getState().result).toBeNull();
  });
});
