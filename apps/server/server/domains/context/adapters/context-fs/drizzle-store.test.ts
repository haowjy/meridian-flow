/** ContextFS Drizzle-store shadow observer behavior. */
import { describe, expect, it, vi } from "vitest";
import { notifyMembershipObserver } from "./drizzle-store.js";

describe("notifyMembershipObserver", () => {
  it("keeps shadow membership failures off the user operation path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
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
      ).not.toThrow();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    } finally {
      warn.mockRestore();
    }
  });
});
