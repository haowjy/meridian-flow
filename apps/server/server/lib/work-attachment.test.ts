/** Root omit/null and child inherit bind a real No Work primary. */
import { describe, expect, it } from "vitest";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
} from "../domains/projects/index.js";
import { createInMemoryAppServices } from "./compose.js";
import { InvalidWorkAttachmentError, resolveWorkMembership } from "./work-attachment.js";

describe("resolveWorkMembership", () => {
  async function fixture() {
    const app = createInMemoryAppServices();
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "owner", title: "Agents" });
    const workRepo = createInMemoryWorkRepository();
    const noWork = await workRepo.ensureNoWork(project.id);
    const named = await workRepo.create({ projectId: project.id, name: "Arc" });
    const deps = { workRepo, threadWorks: app.repos.threadWorks };
    const thread = await app.repos.threads.create({
      userId: "owner",
      projectId: project.id,
      title: "Root",
    });
    return { app, deps, project, noWork, named, thread };
  }

  it("binds omitted workId to No Work", async () => {
    const { deps, project, noWork, thread } = await fixture();
    await expect(
      resolveWorkMembership(deps, { threadId: thread.id, projectId: project.id }),
    ).resolves.toBe(noWork.id);
    await expect(deps.threadWorks.findPrimary(thread.id)).resolves.toEqual({ workId: noWork.id });
  });

  it("binds explicit null workId to No Work", async () => {
    const { deps, project, noWork, thread } = await fixture();
    await expect(
      resolveWorkMembership(deps, {
        threadId: thread.id,
        projectId: project.id,
        workId: null,
      }),
    ).resolves.toBe(noWork.id);
    await expect(deps.threadWorks.findPrimary(thread.id)).resolves.toEqual({ workId: noWork.id });
  });

  it("lets a child inherit the parent's No Work primary", async () => {
    const { app, deps, project, noWork, thread } = await fixture();
    await resolveWorkMembership(deps, { threadId: thread.id, projectId: project.id, workId: null });
    const child = await app.repos.threads.create({
      userId: "owner",
      projectId: project.id,
      title: "Child",
    });
    await expect(
      resolveWorkMembership(deps, {
        threadId: child.id,
        projectId: project.id,
        parentThreadId: thread.id,
      }),
    ).resolves.toBe(noWork.id);
    await expect(deps.threadWorks.findPrimary(child.id)).resolves.toEqual({ workId: noWork.id });
  });

  it("lets a child inherit the parent's named primary", async () => {
    const { app, deps, project, named, thread } = await fixture();
    await resolveWorkMembership(deps, {
      threadId: thread.id,
      projectId: project.id,
      workId: named.id,
    });
    const child = await app.repos.threads.create({
      userId: "owner",
      projectId: project.id,
      title: "Child",
    });
    await expect(
      resolveWorkMembership(deps, {
        threadId: child.id,
        projectId: project.id,
        parentThreadId: thread.id,
      }),
    ).resolves.toBe(named.id);
  });

  it("throws when No Work is missing", async () => {
    const app = createInMemoryAppServices();
    const projects = createInMemoryProjectRepository();
    const project = await projects.create({ userId: "owner", title: "Agents" });
    const thread = await app.repos.threads.create({
      userId: "owner",
      projectId: project.id,
      title: "Root",
    });
    await expect(
      resolveWorkMembership(
        { workRepo: createInMemoryWorkRepository(), threadWorks: app.repos.threadWorks },
        { threadId: thread.id, projectId: project.id },
      ),
    ).rejects.toBeInstanceOf(InvalidWorkAttachmentError);
  });
});
