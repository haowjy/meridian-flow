/** Unit contracts for release-runner operator diagnostics. */
import { describe, expect, it } from "vitest";
import { DatabaseHistoryRefusalError, formatDatabaseHistoryRefusal } from "./release-runner";

describe("formatDatabaseHistoryRefusal", () => {
  it("prints typed history issues and shared-database repair guidance", () => {
    const error = new DatabaseHistoryRefusalError([
      { kind: "unknown", applied: { hash: "abcdef1234567890", createdAt: 123 } },
    ]);

    const message = formatDatabaseHistoryRefusal(error);

    expect(message).toContain("hash abcdef123456 at created_at 123");
    expect(message).toContain("requires human repair");
    expect(message).not.toContain("pnpm db:reset");
  });
});
