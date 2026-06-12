/**
 * Context-port factory tests: protect tenant-scoped URI routing at the
 * composition boundary where ContextFS becomes workbench-aware.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkbenchContextPortFactory } from "./index.js";

describe("createInMemoryWorkbenchContextPortFactory", () => {
  it("routes fs1 reads and writes through a workbench-scoped ContextFS", async () => {
    const factory = createInMemoryWorkbenchContextPortFactory();
    const scope = { userId: "user_1", workbenchId: "project_1" };
    const port = factory.forWorkbench(scope.workbenchId, scope.userId);

    await expect(
      port.write("fs1://notes/run.md", "online", { origin: { type: "system" } }),
    ).resolves.toMatchObject({ ok: true });

    await expect(port.read("fs1://notes/run.md")).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({ content: "online" }),
    });
    await expect(port.stat("fs1://notes/run.md")).resolves.toMatchObject({
      ok: true,
      value: { kind: "tracked", uri: "fs1://notes/run.md" },
    });
  });

  it("keeps workbench file trees isolated by workbench", async () => {
    const factory = createInMemoryWorkbenchContextPortFactory();
    const userId = "user_1";
    const first = factory.forWorkbench("project_1", userId);
    const second = factory.forWorkbench("project_2", userId);

    await expect(
      first.write("fs1://shared.txt", "from project 1", { origin: { type: "system" } }),
    ).resolves.toMatchObject({ ok: true });

    await expect(first.read("fs1://shared.txt")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "from project 1" }),
    });
    await expect(second.read("fs1://shared.txt")).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("keeps same-workbench context isolated by user for in-memory test stores", async () => {
    const factory = createInMemoryWorkbenchContextPortFactory();
    const owner = factory.forWorkbench("project_1", "owner");
    const collaborator = factory.forWorkbench("project_1", "collaborator");

    await expect(
      owner.write("kb://notes/private.md", "owner note", { origin: { type: "system" } }),
    ).resolves.toMatchObject({ ok: true });

    await expect(owner.read("kb://notes/private.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "owner note" }),
    });
    await expect(collaborator.read("kb://notes/private.md")).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});
