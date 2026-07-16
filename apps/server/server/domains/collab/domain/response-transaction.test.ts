/** Response unit-of-work settlement behavior. */
import { describe, expect, it, vi } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { enlistResponseParticipant, runResponseTransaction } from "./response-transaction.js";

describe("ResponseTransaction", () => {
  it("commits participants in enrollment order after the durable boundary", async () => {
    const events: string[] = [];
    await runResponseTransaction(
      async (operation) => {
        const result = await operation();
        events.push("database committed");
        return result;
      },
      async () => {
        enlistResponseParticipant({ commit: () => void events.push("first"), abort: vi.fn() });
        enlistResponseParticipant({ commit: () => void events.push("second"), abort: vi.fn() });
      },
    );
    expect(events).toEqual(["database committed", "first", "second"]);
  });

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

  it("aborts participants when an ambient outer transaction later rolls back", async () => {
    const events: string[] = [];
    const db = {
      transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({}),
    };

    await expect(
      runInDrizzleTransaction(db as never, async () => {
        await runResponseTransaction(
          async (operation) => operation(),
          async () => {
            enlistResponseParticipant({
              commit: () => void events.push("commit"),
              abort: () => void events.push("abort"),
            });
          },
        );
        events.push("operation returned");
        throw new Error("later outer failure");
      }),
    ).rejects.toThrow("later outer failure");

    expect(events).toEqual(["operation returned", "abort"]);
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
