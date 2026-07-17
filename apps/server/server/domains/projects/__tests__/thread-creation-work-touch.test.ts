import { describe, expect, it } from "vitest";
import { createThreadForProject } from "../../../lib/thread-creation.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
  type WorkRepository,
} from "../index.js";

describe("createThreadForProject work activity", () => {
  it("touches the attached work after creating a project thread", async () => {
    const projects = createInMemoryProjectRepository();
    const baseWorkRepo = createInMemoryWorkRepository();
    const touchedIds: string[] = [];
    const workRepo: WorkRepository = {
      ...baseWorkRepo,
      async touch(id) {
        touchedIds.push(id);
        await baseWorkRepo.touch(id);
      },
    };
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: "user-1", title: "Sample Project" });

    const thread = await createThreadForProject(
      {
        projects,
        workRepo,
        threads: repos.threads,
        threadWorks: repos.threadWorks,
        transaction: repos.transaction,
        eventSink: createInMemoryEventSink(),
      },
      { projectId: project.id, userId: "user-1", title: "Root thread" },
    );

    expect(thread.workId).toBeTruthy();
    expect(touchedIds).toEqual([thread.workId]);
  });

  it("refuses implicit attachment when the project has multiple active Works", async () => {
    const projects = createInMemoryProjectRepository();
    const workRepo = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ projects });
    const project = await projects.create({ userId: "user-1", title: "Sample Project" });
    await workRepo.create({ projectId: project.id, createdByUserId: "user-1", title: "One" });
    await workRepo.create({ projectId: project.id, createdByUserId: "user-1", title: "Two" });

    await expect(
      createThreadForProject(
        {
          projects,
          workRepo,
          threads: repos.threads,
          threadWorks: repos.threadWorks,
          transaction: repos.transaction,
          eventSink: createInMemoryEventSink(),
        },
        { projectId: project.id, userId: "user-1", title: "Root thread" },
      ),
    ).rejects.toThrow("expected one");
  });
});
