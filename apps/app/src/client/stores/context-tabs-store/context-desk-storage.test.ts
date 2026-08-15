import { describe, expect, it } from "vitest";
import { DeviceContextDeskStore } from "./context-desk-storage";

describe("context desk persistence", () => {
  it("does not persist draft review identity", () => {
    let raw: string | null = null;
    const store = new DeviceContextDeskStore({
      getItem: () => raw,
      removeItem: () => {
        raw = null;
      },
      setItem: (_key, value) => {
        raw = value;
      },
    });
    store.setUser("user-1", () => false);
    store.replace(
      {
        "project-1": {
          activeTabId: "document-1",
          tabs: [
            {
              kind: "tracked",
              documentId: "document-1",
              scheme: "manuscript",
              path: "/chapter.md",
              name: "chapter.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
              reviewWorkId: "work-a",
            },
          ],
        },
      },
      () => false,
    );

    expect(raw).not.toContain("reviewWorkId");
  });
});
