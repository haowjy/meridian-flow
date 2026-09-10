/** Browser untitled recovery reads the complete catalog before choosing a Work. */
import { describe, expect, it, vi } from "vitest";
import { confirmUntitledCreate, resolveUntitledCatalogHome } from "./untitled-reconciler-browser";

describe("resolveUntitledCatalogHome", () => {
  it("uses explicit no-Work authority without selecting a catalog Work", async () => {
    await expect(resolveUntitledCatalogHome("project")).resolves.toBeNull();
  });
});

describe("confirmUntitledCreate", () => {
  it("uses the existing project-final coordinator and preserves its moved entry", async () => {
    const moved = {
      kind: "available" as const,
      documentId: "document",
      generation: "2",
      authority: {
        kind: "work" as const,
        projectId: "project",
        workId: "work-b",
        workSlug: "work-b" as never,
      },
      entry: { uri: "manuscript://@work-b/Moved.md" },
    } as never;
    const resolveForOpen = vi.fn(async () => moved);

    await expect(confirmUntitledCreate({ resolveForOpen }, "project", "document")).resolves.toBe(
      moved,
    );
    expect(resolveForOpen).toHaveBeenCalledExactlyOnceWith("project", "document");
  });
});
