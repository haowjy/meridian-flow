/** ContextFS membership observer unit behavior. */
import { describe, expect, it } from "vitest";
import { notifyMembershipObserver } from "./drizzle-store.js";

describe("notifyMembershipObserver", () => {
  it("surfaces shadow membership failures on the user operation path", async () => {
    await expect(
      notifyMembershipObserver(
        {
          documentCreated: () => {
            throw new Error("shadow failed");
          },
          documentDeleted: () => undefined,
        },
        "documentCreated",
        "doc-1",
      ),
    ).rejects.toThrow("shadow failed");
  });
});
