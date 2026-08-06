/** Upload route coverage for scheme-root default placement. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ok } from "../../../../../../shared/result.js";
import { resolveContextRoute } from "./_helpers.js";
import handler from "./upload.post.js";

vi.mock("./_helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_helpers.js")>()),
  resolveContextRoute: vi.fn(),
}));

describe("POST context upload", () => {
  beforeEach(() => {
    vi.mocked(resolveContextRoute).mockReset();
  });

  it("defaults a path-less upload to the bare filename at the scheme root", async () => {
    const stat = vi.fn(async () => ({ ok: false, error: { code: "not_found" } }));
    const writeBinary = vi.fn(async () => Ok({ documentId: "document-1" }));
    vi.mocked(resolveContextRoute).mockResolvedValue({
      app: {
        objectStore: {
          put: vi.fn(async () => Ok({ storageUrl: "storage://cover" })),
          delete: vi.fn(),
        },
      },
      userId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      scheme: "uploads",
      workId: "00000000-0000-4000-8000-000000000003",
      port: { stat, writeBinary },
    } as never);
    const body = new FormData();
    body.set("file", new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" }));
    const event = {
      req: new Request("https://server.local/upload", { method: "POST", body }),
      res: { status: 200 },
    };

    await expect(handler(event as never)).resolves.toEqual({
      ok: true,
      documentId: "document-1",
    });
    expect(stat).toHaveBeenCalledWith("uploads://00000000-0000-4000-8000-000000000003/cover.png");
    expect(writeBinary).toHaveBeenCalledWith(
      "uploads://00000000-0000-4000-8000-000000000003/cover.png",
      expect.any(Object),
    );
    expect(event.res.status).toBe(201);
  });

  it.each([
    ["root", "@cover.png", null],
    ["nested", "cover.png", "Drafts/@cover.png"],
  ])("rejects an authority-like %s upload path before storage", async (_label, filename, path) => {
    const put = vi.fn(async () => Ok({ storageUrl: "storage://cover" }));
    const stat = vi.fn(async () => ({ ok: false, error: { code: "not_found" } }));
    vi.mocked(resolveContextRoute).mockResolvedValue({
      app: { objectStore: { put, delete: vi.fn() } },
      userId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      scheme: "uploads",
      workId: "00000000-0000-4000-8000-000000000003",
      port: { stat, writeBinary: vi.fn() },
    } as never);
    const body = new FormData();
    body.set("file", new File([new Uint8Array([1, 2, 3])], filename, { type: "image/png" }));
    if (path) body.set("path", path);
    const event = {
      req: new Request("https://server.local/upload", { method: "POST", body }),
      res: { status: 200 },
    };

    await expect(handler(event as never)).rejects.toMatchObject({
      statusCode: 400,
      data: expect.objectContaining({ reason: "name/reserved-authority-qualifier" }),
    });
    expect(stat).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
