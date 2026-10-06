/** Work lifecycle refusals are immutable outcomes, not infrastructure outages. */
import type { ContextOperationReceipt, ContextOperationResult } from "@meridian/contracts/protocol";
import { expect, it, vi } from "vitest";
import { ContextOperationReceipts } from "../domains/context/context/context-operation-receipts.js";
import { contextErrorToHttp } from "./context-error-http.js";
import { type ContextMoveRouteDeps, handleContextMoveRequest } from "./context-move-route.js";
import { HTTP_INTERRUPT_ENVELOPE_KEY } from "./interrupt-boundary.js";

it("records Work refusals and replays the same final HTTP code even after recovery", async () => {
  for (const reason of ["work_archived", "work_deleted", "work_missing"] as const) {
    let saved: ContextOperationReceipt | null = null;
    const receipts = new ContextOperationReceipts({
      transaction: async (_id, run) => run(),
      savepoint: async (run) => run(),
      lookup: async () => saved,
      insert: async (receipt) => {
        saved = receipt;
      },
    });
    const command = {
      kind: "delete" as const,
      uri: "scratch://@arc/note.md",
      expected: { kind: "file" as const, documentId: "document" },
    };
    const refusal: ContextOperationResult<"delete"> = {
      ok: false,
      error: { code: "context_unavailable", reason, workSlug: "arc", uri: command.uri },
    };
    const first = await receipts.execute("operation", command, async () => refusal);
    expect(saved).toMatchObject({ result: refusal });
    const replay = await receipts.execute("operation", command, async () => {
      throw new Error("A recorded refusal must never execute again");
    });
    expect(replay).toEqual(first);
    for (const result of [first, replay]) {
      if (result.ok) throw new Error("Expected refusal");
      expect(() => contextErrorToHttp(result.error)).toThrowError(
        expect.objectContaining({
          statusCode: reason === "work_archived" ? 409 : 404,
          data: {
            [HTTP_INTERRUPT_ENVELOPE_KEY]: expect.objectContaining({
              error: expect.objectContaining({ code: reason, retryable: false }),
            }),
          },
        }),
      );
    }
    saved = null;
    await receipts.execute("outage", command, async () => ({
      ok: false,
      error: { code: "io_error", uri: command.uri, message: "Offline" },
    }));
    expect(saved).toBeNull();
  }
});

vi.mock("../domains/projects/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../domains/projects/index.js")>()),
  requireProjectOwner: vi.fn(),
}));

it("finally refuses a missing Work locator before dispatch, identically on replay", async () => {
  const byId = vi.fn(async () => null);
  const listByProject = vi.fn();
  const deps = {
    projectRepo: {},
    workRepo: { listByProject },
    workAuthorityResolver: { byId },
    contextPorts: {},
  } as unknown as ContextMoveRouteDeps;
  for (const scheme of ["scratch", "uploads"] as const) {
    for (const missingSide of ["source", "destination"] as const) {
      const request = {
        projectId: "project",
        userId: "writer",
        sourceScheme: missingSide === "source" ? scheme : "unfiled",
        body: {
          operationId: "12345678-1234-4234-8234-123456789abc",
          expected: { kind: "file", nodeId: "document" },
          path: "note.md",
          destinationScheme: scheme,
          destinationFolderPath: "",
          ...(missingSide === "source"
            ? { sourceWorkId: "deleted-work" }
            : { destinationWorkId: "deleted-work" }),
        },
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(handleContextMoveRequest(deps, request)).rejects.toMatchObject({
          statusCode: 404,
          data: {
            [HTTP_INTERRUPT_ENVELOPE_KEY]: expect.objectContaining({
              error: expect.objectContaining({ code: "work_missing", retryable: false }),
            }),
          },
        });
      }
    }
  }
  expect(listByProject).not.toHaveBeenCalled();
});
