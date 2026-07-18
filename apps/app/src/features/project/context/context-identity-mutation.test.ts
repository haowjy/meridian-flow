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
});
