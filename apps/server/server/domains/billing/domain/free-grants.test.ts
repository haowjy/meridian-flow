import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../adapters/in-memory/credit-ledger.js";
import { createFreeGrantPipeline, FREE_MONTHLY_MILLICREDITS } from "./free-grants.js";

const userId = "user-1";
const projectId = "billing";

describe("free grant pipeline", () => {
  it("grants signup credits once for a new user", async () => {
    const ledger = createInMemoryCreditLedger();
    const grants = createFreeGrantPipeline({
      ledger,
      clock: { now: () => new Date("2026-06-12T00:00:00.000Z") },
    });

    await grants.ensureFreeCredits({ userId, projectId });
    await grants.ensureFreeCredits({ userId, projectId });

    expect(await ledger.getBalance({ userId, projectId })).toBe(FREE_MONTHLY_MILLICREDITS);
    const transactions = await ledger.listTransactions({ userId, projectId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.reason).toBe("signup");
  });

  it("adds the next monthly grant idempotently after the signup month", async () => {
    const ledger = createInMemoryCreditLedger();
    await createFreeGrantPipeline({
      ledger,
      clock: { now: () => new Date("2026-06-12T00:00:00.000Z") },
    }).ensureFreeCredits({ userId, projectId });

    const july = createFreeGrantPipeline({
      ledger,
      clock: { now: () => new Date("2026-07-01T00:00:00.000Z") },
    });
    await july.ensureFreeCredits({ userId, projectId });
    await july.ensureFreeCredits({ userId, projectId });

    expect(await ledger.getBalance({ userId, projectId })).toBe("400000");
    const reasons = (await ledger.listTransactions({ userId, projectId })).map((tx) => tx.reason);
    expect(reasons.sort()).toEqual(["monthly_2026_07", "signup"]);
  });
});
