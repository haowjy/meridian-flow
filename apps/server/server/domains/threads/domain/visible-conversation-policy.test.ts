import { describe, expect, it } from "vitest";
import { isThreadActionRequired } from "./visible-conversation-policy.js";

describe("isThreadActionRequired", () => {
  it("keeps a parked assistant actionable when a writer turn is the lineage head", () => {
    expect(
      isThreadActionRequired({
        activeLineage: [
          { role: "user", status: "complete" },
          { role: "assistant", status: "waiting_interrupt" },
        ],
      }),
    ).toBe(true);
  });

  it("uses the nearest assistant rather than a stale waiting ancestor", () => {
    expect(
      isThreadActionRequired({
        activeLineage: [
          { role: "assistant", status: "streaming" },
          { role: "user", status: "complete" },
          { role: "assistant", status: "waiting_interrupt" },
        ],
      }),
    ).toBe(false);
  });
});
