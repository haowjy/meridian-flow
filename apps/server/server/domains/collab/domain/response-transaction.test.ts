/** Response unit-of-work settlement behavior. */
import { describe, expect, it, vi } from "vitest";
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
});
