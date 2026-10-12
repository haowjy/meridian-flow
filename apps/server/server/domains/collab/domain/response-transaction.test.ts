/** Response unit-of-work settlement behavior. */
import { describe, expect, it, vi } from "vitest";
import { enlistResponseParticipant, runResponseTransaction } from "./response-transaction.js";

describe("ResponseTransaction", () => {
  it("aborts every participant in reverse order and tolerates idempotent aborts", async () => {
    const events: string[] = [];
    const abort = vi.fn(() => void events.push("first"));
    await expect(
      runResponseTransaction(
        async (operation) => operation(),
        async () => {
          enlistResponseParticipant({ commit: vi.fn(), abort });
          enlistResponseParticipant({ commit: vi.fn(), abort: () => void events.push("second") });
          throw new Error("fail");
        },
      ),
    ).rejects.toThrow("fail");
    expect(events).toEqual(["second", "first"]);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("keeps durable success total when one commit participant fails", async () => {
    const events: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runResponseTransaction(
          async (operation) => operation(),
          async () => {
            enlistResponseParticipant({
              commit() {
                events.push("failed");
                throw new Error("publish failed");
              },
              abort: vi.fn(),
            });
            enlistResponseParticipant({
              commit: () => void events.push("remaining"),
              abort: vi.fn(),
            });
            return "committed";
          },
        ),
      ).resolves.toBe("committed");
    } finally {
      consoleError.mockRestore();
    }

    expect(events).toEqual(["failed", "remaining"]);
  });
});
