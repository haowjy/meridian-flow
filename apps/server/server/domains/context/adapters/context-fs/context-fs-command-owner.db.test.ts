/** Result-aware command barriers at the ContextFS production owner. */
import { describe, expect, it, vi } from "vitest";
import { Ok } from "../../../../shared/result.js";
import { createResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { ContextCommandTransaction } from "../../ports/context-command-transaction.js";

const _SOURCE_ID = "00000000-0000-4000-8000-000000000911";
const _UNTITLED_ID = "00000000-0000-4000-8000-000000000912";

describe("ResultAwareCommandExecutor at the ContextFS owner", () => {
  it("serializes same-owner commands through transaction callback settlement", async () => {
    let settleFirst!: () => void;
    const firstCallbacksSettled = new Promise<void>((resolve) => {
      settleFirst = resolve;
    });
    let transactionEntries = 0;
    const transaction: ContextCommandTransaction = {
      run: async (operation) => {
        transactionEntries += 1;
        const result = await operation();
        if (transactionEntries === 1) await firstCallbacksSettled;
        return result;
      },
    };
    const executor = createResultAwareCommandExecutor({
      transaction,
      serializeThroughCallbacks: true,
    });

    const first = executor.run(async () => Ok("first"));
    await vi.waitFor(() => expect(transactionEntries).toBe(1));
    const second = executor.run(async () => Ok("second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transactionEntries).toBe(1);

    settleFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([Ok("first"), Ok("second")]);
    expect(transactionEntries).toBe(2);
  });
});
