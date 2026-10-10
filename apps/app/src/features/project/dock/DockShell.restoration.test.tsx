// @vitest-environment jsdom
/** Document restoration must not rewrite the persisted candidate or cancel the pending document. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DockShell } from "./DockShell";
import { useDockDocumentStore } from "./dock-document-store";

vi.mock("../DesktopProjectController", () => ({ usePresentedDockDocument: () => undefined }));
vi.mock("./DockDocumentView", () => ({ DockDocumentView: () => null }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("uses the native occupant during restoration without committing a new intent", async () => {
  useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true);
  const restoring = {
    review: null,
    projectId: "project",
    screen: "chat" as const,
    tab: { kind: "new" as const, documentId: "local", resourceHandle: "local", name: "Untitled" },
  };
  useDockDocumentStore.setState({ restoring });
  const revision = useDockDocumentStore.getState().revision;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <DockShell projectId="project" placement="dock" screen="chat" renderHeader={() => null}>
          <p>Recent</p>
        </DockShell>,
      ),
    );
    expect(container.textContent).toBe("Recent");
    expect(useDockDocumentStore.getState().restoring).toBe(restoring);
    expect(useDockDocumentStore.getState().revision).toBe(revision);
  } finally {
    await act(async () => root.unmount());
    useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true);
  }
});
