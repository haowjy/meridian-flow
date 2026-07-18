/** Cache-receipt coverage for foreground and background identity mutations. */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { moveContextEntry } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { createContextIdentityMutationService } from "./context-identity-mutation";

describe("context identity mutation cache receipts", () => {
  it("invalidates the canonical tree after background materialization", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const service = createContextIdentityMutationService(queryClient);

    await service.materialized("project-1", {
      status: "created",
      documentId: "doc-1",
      scheme: "scratch",
      path: "/Untitled",
      name: "Untitled",
      workId: "work-1",
    });

    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.contextTree("project-1", "scratch", "work-1"),
    });
  });

  it("invalidates both source and destination trees after a move", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const move = vi.fn<typeof moveContextEntry>().mockResolvedValue({
      status: "moved",
      scheme: "manuscript",
      path: "Act 1/Opening.md",
      name: "Opening.md",
    });
    const service = createContextIdentityMutationService(queryClient, move);

    await service.move(
      "doc-1",
      "project-1",
      { scheme: "scratch", path: "/Untitled", workId: "work-1" },
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );

    expect(move).toHaveBeenCalledWith("project-1", "scratch", {
      path: "Untitled",
      sourceWorkId: "work-1",
      destinationScheme: "manuscript",
      destinationFolderPath: "Act 1",
      newName: "Opening.md",
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.contextTree("project-1", "scratch", "work-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.contextTree("project-1", "manuscript", undefined),
    });
  });

  it("serializes one document's moves and rebases the newest intent on the canonical receipt", async () => {
    const queryClient = new QueryClient();
    let finishBackground!: (result: Awaited<ReturnType<typeof moveContextEntry>>) => void;
    const move = vi
      .fn<typeof moveContextEntry>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishBackground = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: "moved",
        scheme: "manuscript",
        path: "Final/Latest.md",
        name: "Latest.md",
      });
    const service = createContextIdentityMutationService(queryClient, move);

    const background = service.move(
      "doc-1",
      "project-1",
      { scheme: "scratch", path: "/Untitled.md", workId: "work-1" },
      { name: "Background.md", destination: { scheme: "manuscript", folderPath: "/Drafts" } },
    );
    const foreground = service.move(
      "doc-1",
      "project-1",
      { scheme: "scratch", path: "/Untitled.md", workId: "work-1" },
      { name: "Latest.md", destination: { scheme: "manuscript", folderPath: "/Final" } },
    );

    await Promise.resolve();
    expect(move).toHaveBeenCalledOnce();
    finishBackground({
      status: "moved",
      scheme: "manuscript",
      path: "Drafts/Background.md",
      name: "Background.md",
    });

    await expect(background).resolves.toMatchObject({ isLatest: false });
    await expect(foreground).resolves.toMatchObject({ isLatest: true });
    expect(move).toHaveBeenNthCalledWith(2, "project-1", "manuscript", {
      path: "Drafts/Background.md",
      destinationScheme: "manuscript",
      destinationFolderPath: "Final",
      newName: "Latest.md",
    });
  });
});
