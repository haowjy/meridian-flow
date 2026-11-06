/** Work lifecycle refusals are immutable outcomes, not infrastructure outages. */
import type { ContextOperationReceipt, ContextOperationResult } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { ContextOperationReceipts } from "../domains/context/context/context-operation-receipts.js";
import { HTTP_INTERRUPT_ENVELOPE_KEY } from "../shared/interrupt-boundary.js";
import { contextErrorToHttp } from "./context-error-http.js";

it("records Work refusals and replays the same final HTTP code even after recovery", async () => {
  for (const reason of ["work_archived", "work_deleted", "work_missing"] as const) {
    let saved: ContextOperationReceipt | null = null;
    const receipts = new ContextOperationReceipts({
      transaction: async (_id, run) => run(),
      observationVersion: async () => "1",
      savepoint: async (run) => run(),
      lookup: async () => saved,
      insert: async (receipt) => {
        saved = receipt;
      },
    });
    const command = {
      kind: "delete" as const,
      expected: { kind: "file" as const, nodeId: "document" },
    };
    const uri = "scratch://@w1/note.md";
    const refusal: ContextOperationResult<"delete"> = {
      ok: false,
      error: { code: "context_unavailable", reason, workHandle: "arc", uri },
    };
    const first = await receipts.execute("operation", command, uri, async () => refusal);
    expect(saved).toMatchObject({ result: refusal });
    const replay = await receipts.execute("operation", command, uri, async () => {
      throw new Error("A recorded refusal must never execute again");
    });
    expect(replay).toEqual(first);
    for (const result of [first, replay]) {
      if (result.ok) throw new Error("Expected refusal");
      expect(() => contextErrorToHttp(result.error)).toThrowError(
        expect.objectContaining({
          statusCode: reason === "work_archived" ? 403 : 404,
          data: {
            [HTTP_INTERRUPT_ENVELOPE_KEY]: expect.objectContaining({
              error: expect.objectContaining({ code: reason, retryable: false }),
            }),
          },
        }),
      );
    }
    saved = null;
    const outage = await receipts.execute("outage", command, uri, async () => ({
      ok: false,
      error: { code: "io_error", uri, message: "Offline" },
    }));
    expect(saved).toBeNull();
    if (outage.ok) throw new Error("Expected infrastructure failure");
    expect(() => contextErrorToHttp(outage.error)).toThrowError(
      expect.objectContaining({
        statusCode: 502,
        data: {
          [HTTP_INTERRUPT_ENVELOPE_KEY]: expect.objectContaining({
            error: expect.objectContaining({ code: "io_error", retryable: true }),
          }),
        },
      }),
    );
  }
});
