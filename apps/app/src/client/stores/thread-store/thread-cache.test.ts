import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { createThreadCache } from "./thread-cache";

describe("terminal turn cache fan-out", () => {
  it("invalidates the snapshot, thread list, and canonical Work catalog", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    createThreadCache(client).invalidateThread("thread-1", "project-1");
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: threadQueryKeys.snapshot("thread-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectQueryKeys.threads("project-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectQueryKeys.works("project-1") });
  });
});
