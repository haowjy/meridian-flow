/**
 * Unified context-port factory tests: in-memory parity for project/work schemes,
 * manuscript bare-path default, primary-Work authority routing, and atomic edits.
 */
import type { UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "../projects/index.js";
import { createInMemoryRepositories } from "../threads/adapters/in-memory/index.js";
import { contextPortForThread, resolveThreadContext } from "./context-port-resolution.js";
import { createInMemoryUnifiedContextPortFactory } from "./unified-context-port-factory.js";

const USER = "00000000-0000-4000-8000-000000000303" as UserId;

describe("createInMemoryUnifiedContextPortFactory", () => {
  it("routes manuscript reads and writes through project-scoped ContextFS", async () => {
    const factory = createInMemoryUnifiedContextPortFactory();
    const port = factory.forProject("project_1", "user_1");

    await expect(
      port.write("manuscript://chapter-1.md", "# Chapter 1", { origin: { type: "system" } }),
    ).resolves.toMatchObject({ ok: true });

    await expect(port.read("manuscript://chapter-1.md")).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ content: "# Chapter 1\n" }),
    });
  });

  it("defaults bare paths to manuscript://", async () => {
    const factory = createInMemoryUnifiedContextPortFactory();
    const port = factory.forProject("project_1", "user_1");

    await port.write("notes/draft.md", "bare path", { origin: { type: "system" } });
    const read = await port.read("manuscript://notes/draft.md");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("bare path\n");
  });

  it("keeps project manuscript trees isolated by project", async () => {
    const factory = createInMemoryUnifiedContextPortFactory();
    const first = factory.forProject("project_1", "user_1");
    const second = factory.forProject("project_2", "user_1");

    await first.write("manuscript://shared.md", "from project 1", { origin: { type: "system" } });
    await expect(first.read("manuscript://shared.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "from project 1\n" }),
    });
    await expect(second.read("manuscript://shared.md")).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("shares manuscript and kb stores across users in the same project", async () => {
    const factory = createInMemoryUnifiedContextPortFactory();
    const userA = factory.forProject("project_1", "user_a");
    const userB = factory.forProject("project_1", "user_b");

    await userA.write("manuscript://shared.md", "project manuscript", {
      origin: { type: "system" },
    });
    await userA.write("kb://refs.md", "project kb", { origin: { type: "system" } });

    await expect(userB.read("manuscript://shared.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "project manuscript\n" }),
    });
    await expect(userB.read("kb://refs.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "project kb\n" }),
    });
  });

  it("shares user:// stores across projects for the same user", async () => {
    const factory = createInMemoryUnifiedContextPortFactory();
    const projectA = factory.forProject("project_1", "user_1");
    const projectB = factory.forProject("project_2", "user_1");

    await projectA.write("user://profile.md", "cross-project profile", {
      origin: { type: "system" },
    });
    await expect(projectB.read("user://profile.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "cross-project profile\n" }),
    });
  });

  it("routes work-scoped URIs through forWork with primary Work default", async () => {
    const workId = "00000000-0000-4000-8000-0000000000aa";
    const factory = createInMemoryUnifiedContextPortFactory();
    const workPort = factory.forWork(workId, "project_1", "user_1", new Set([workId]));

    await workPort.write("work://plan.md", "scratch", { origin: { type: "system" } });
    await expect(workPort.read("work://plan.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "scratch\n" }),
    });
  });

  it("resolves authority-addressed work URIs only for allowed Works", async () => {
    const workA = "00000000-0000-4000-8000-000000000001";
    const workB = "00000000-0000-4000-8000-000000000002";
    const workC = "00000000-0000-4000-8000-000000000003";
    const factory = createInMemoryUnifiedContextPortFactory();
    const port = factory.forWork(workA, "project_1", "user_1", new Set([workA, workB]));

    await port.write(`work://${workB}/notes.md`, "other work", { origin: { type: "system" } });
    await expect(port.read(`work://${workB}/notes.md`)).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "other work\n" }),
    });

    await expect(port.read(`work://${workC}/notes.md`)).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });

  it("resolves thread context to a work-aware port via contextPortForThread", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);

    const factory = createInMemoryUnifiedContextPortFactory();
    const resolution = await resolveThreadContext(
      { threads: repos.threads, threadWorks: repos.threadWorks },
      thread.id,
    );
    expect(resolution?.primaryWorkId).toBe(work.id);
    if (!resolution) throw new Error("Expected thread context resolution");

    const port = contextPortForThread(factory, resolution);
    await port.write("manuscript://chapter-1.md", "thread manuscript", {
      origin: { type: "system" },
    });
    await port.write("work://scratch.md", "thread scratch", { origin: { type: "system" } });

    const projectOnly = factory.forProject("project_1", "user_1");
    await expect(projectOnly.read("work://scratch.md")).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await expect(port.read("work://scratch.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "thread scratch\n" }),
    });
  });

  it("applies parallel human edits through the facade editDocument path without clobbering", async () => {
    const factory = createInMemoryUnifiedContextPortFactory();
    const port = factory.forProject("project_1", USER);

    await port.write("manuscript://chapter-1.md", "# Chapter\n\nBody and tail", {
      origin: { type: "human", userId: USER },
    });

    await Promise.all([
      port.edit("manuscript://chapter-1.md", (content) => content.replace("Body", "Body a"), {
        origin: { type: "human", userId: USER },
      }),
      port.edit("manuscript://chapter-1.md", (content) => content.replace("tail", "tail b"), {
        origin: { type: "human", userId: USER },
      }),
    ]);

    const read = await port.read("manuscript://chapter-1.md");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toBe("# Chapter\n\nBody a and tail b\n");
    }
  });
});
