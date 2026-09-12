/** Browser Untitled recovery uses project-final identity resolution. */
import { describe, expect, it, vi } from "vitest";
import { confirmUntitledCreate } from "./untitled-reconciler-browser";

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
