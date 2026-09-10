import { describe, expect, it } from "vitest";
import { testWorkSlug } from "../../test-support/work-slug.js";
import { resolvedWorkAuthority } from "../projects/domain/work-authority.js";
import { createInMemoryUnifiedContextPortFactory } from "./unified-context-port-factory.js";

describe("project-owned unassigned context", () => {
  it("writes contextual Scratch under explicit no-Work authority", async () => {
    const port = createInMemoryUnifiedContextPortFactory().forProject("project", "user", new Map());
    await expect(port.write("scratch://notes/plan.md", "Plan")).resolves.toMatchObject({
      ok: true,
    });
    await expect(port.read("scratch://@/notes/plan.md")).resolves.toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("Plan") },
    });
    await expect(port.list("scratch://@/notes")).resolves.toMatchObject({
      ok: true,
      value: [{ uri: "scratch://@/notes/plan.md" }],
    });
  });

  it("accepts flat no-Work upload intake", async () => {
    const port = createInMemoryUnifiedContextPortFactory().forProject("project", "user", new Map());
    await expect(
      port.writeBinary("uploads://cover.png", {
        storageUrl: "storage://cover",
        mimeType: "image/png",
        sizeBytes: 10,
        fileType: "image",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(port.stat("uploads://@/cover.png")).resolves.toMatchObject({
      ok: true,
      value: { kind: "binary", uri: "uploads://@/cover.png" },
    });
  });

  it("resolves an explicit real-Work authority from a no-Work base port", async () => {
    const port = createInMemoryUnifiedContextPortFactory().forProject(
      "project",
      "user",
      new Map([
        [
          testWorkSlug("arc-one"),
          resolvedWorkAuthority({
            kind: "work",
            workId: "work-1",
            workSlug: testWorkSlug("arc-one"),
          }),
        ],
      ]),
    );

    await expect(port.write("scratch://@arc-one/notes.md", "Arc notes")).resolves.toMatchObject({
      ok: true,
    });
    await expect(port.read("scratch://@arc-one/notes.md")).resolves.toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("Arc notes") },
    });
    await expect(port.stat("scratch://@/notes.md")).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});
