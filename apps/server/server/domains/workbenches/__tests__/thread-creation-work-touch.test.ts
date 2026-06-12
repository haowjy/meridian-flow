import { describe, expect, it } from "vitest";
import { createThreadForWorkbench } from "../../../lib/thread-creation.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import {
  createInMemoryWorkbenchRepository,
  createInMemoryWorkRepository,
  type WorkRepository,
} from "../index.js";

describe("createThreadForWorkbench work activity", () => {
  it("touches the attached work after creating a workbench thread", async () => {
    const workbenches = createInMemoryWorkbenchRepository();
    const baseWorkRepo = createInMemoryWorkRepository();
    const touchedIds: string[] = [];
    const workRepo: WorkRepository = {
      ...baseWorkRepo,
      async touch(id) {
        touchedIds.push(id);
        await baseWorkRepo.touch(id);
      },
    };
    const repos = createInMemoryRepositories({ workbenches });
    const workbench = await workbenches.create({ userId: "user-1", title: "Sample Workbench" });

    const thread = await createThreadForWorkbench(
      { workbenches, workRepo, threads: repos.threads, eventSink: createInMemoryEventSink() },
      { workbenchId: workbench.id, userId: "user-1", title: "Root thread" },
    );

    expect(thread.workId).toBeTruthy();
    expect(touchedIds).toEqual([thread.workId]);
  });
});
