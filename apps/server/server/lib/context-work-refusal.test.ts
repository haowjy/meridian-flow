/** Work lifecycle refusals are immutable outcomes, not infrastructure outages. */
import type { ContextOperationReceipt, ContextOperationResult } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { ContextOperationReceipts } from "../domains/context/context/context-operation-receipts.js";
import { contextErrorToHttp } from "./context-error-http.js";
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
