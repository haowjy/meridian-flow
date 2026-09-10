/** Delete route coverage for exact acknowledged document identities. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Err, Ok } from "../../../../../../shared/result.js";
import { resolveContextRoute } from "./_helpers.js";
import handler from "./delete.post.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000002";

vi.mock("./_helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_helpers.js")>()),
  resolveContextRoute: vi.fn(),
}));

describe("POST context delete", () => {
  beforeEach(() => {
    vi.mocked(resolveContextRoute).mockReset();
  });

  it("returns the exact successful deletion result", async () => {
    const deleteEntry = vi.fn(async () =>
      Ok({
        status: "deleted" as const,
        deletedDocumentIds: [DOCUMENT_ID],
        availabilityGeneration: "42",
      }),
    );
    vi.mocked(resolveContextRoute).mockResolvedValue({
      userId: "00000000-0000-4000-8000-000000000001",
      scheme: "manuscript",
      workId: null,
      port: { delete: deleteEntry },
    } as never);
    const event = {
      req: new Request("https://server.local/delete", {
        method: "POST",
        body: JSON.stringify({
          path: "chapter.md",
          expected: { kind: "file", documentId: DOCUMENT_ID },
        }),
        headers: { "content-type": "application/json" },
      }),
      res: { status: 200 },
    };

    await expect(handler(event as never)).resolves.toEqual({
      status: "deleted",
      deletedDocumentIds: [DOCUMENT_ID],
      availabilityGeneration: "42",
    });
    expect(deleteEntry).toHaveBeenCalledWith(
      "manuscript://chapter.md",
      expect.objectContaining({ expected: { kind: "file", documentId: DOCUMENT_ID } }),
    );
  });

  it("returns the exact populated-folder receipt", async () => {
    vi.mocked(resolveContextRoute).mockResolvedValue({
      userId: "00000000-0000-4000-8000-000000000001",
      scheme: "manuscript",
      workId: null,
      port: {
        delete: vi.fn(async () =>
          Ok({
            status: "deleted" as const,
            deletedDocumentIds: [DOCUMENT_ID, "00000000-0000-4000-8000-000000000003"],
            availabilityGeneration: "43",
          }),
        ),
      },
    } as never);
    const event = {
      req: new Request("https://server.local/delete", {
        method: "POST",
        body: JSON.stringify({
          path: "chapters",
          expected: { kind: "folder" },
        }),
        headers: { "content-type": "application/json" },
      }),
      res: { status: 200 },
    };

    await expect(handler(event as never)).resolves.toEqual({
      status: "deleted",
      deletedDocumentIds: [DOCUMENT_ID, "00000000-0000-4000-8000-000000000003"],
      availabilityGeneration: "43",
    });
  });

  it("preserves stale_target as a named structured conflict", async () => {
    vi.mocked(resolveContextRoute).mockResolvedValue({
      userId: "00000000-0000-4000-8000-000000000001",
      scheme: "manuscript",
      workId: null,
      port: { delete: vi.fn(async () => Err({ code: "stale_target" as const, uri: "x" })) },
    } as never);
    const event = {
      req: new Request("https://server.local/delete", {
        method: "POST",
        body: JSON.stringify({
          path: "chapter.md",
          expected: { kind: "file", documentId: DOCUMENT_ID },
        }),
        headers: { "content-type": "application/json" },
      }),
      res: { status: 200 },
    };

    await expect(handler(event as never)).rejects.toMatchObject({
      statusCode: 409,
      data: {
        __meridianInterruptEnvelope: {
          kind: "error",
          error: {
            code: "stale_target",
            retryable: true,
            source: "system",
          },
        },
      },
    });
  });

  it("rejects a malformed expected document ID before deletion", async () => {
    const deleteEntry = vi.fn();
    vi.mocked(resolveContextRoute).mockResolvedValue({
      userId: "00000000-0000-4000-8000-000000000001",
      scheme: "manuscript",
      workId: null,
      port: { delete: deleteEntry },
    } as never);
    const event = {
      req: new Request("https://server.local/delete", {
        method: "POST",
        body: JSON.stringify({
          path: "chapter.md",
          expected: { kind: "file", documentId: "not-a-uuid" },
        }),
        headers: { "content-type": "application/json" },
      }),
      res: { status: 200 },
    };

    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(deleteEntry).not.toHaveBeenCalled();
  });
});
