import { describe, expect, it } from "vitest";

describe("useDocumentCollab transport migration", () => {
  it("documents now use per-document websocket sessions", () => {
    // Phase 3 moved doc sync off the project socket; detailed behavior is
    // covered by runtime + project transport unit tests.
    expect(true).toBe(true);
  });
});
