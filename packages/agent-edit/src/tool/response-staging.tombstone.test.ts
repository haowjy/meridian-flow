// Closed-response tombstone FIFO cap.
import { describe, expect, it } from "vitest";

import { context, harness } from "./test-support/write-tool-harness.js";

describe("response staging tombstones", () => {
  it("evicts oldest closed-response markers after the FIFO cap", async () => {
    const ctx = harness({ "doc.md": "Body." }, { closedResponseTombstoneCap: 2 });
    await ctx.core.write({ command: "read", file: "doc.md" }, context);

    for (const responseId of ["response-0", "response-1", "response-2"]) {
      await ctx.core.write(
        { command: "insert", file: "doc.md", content: `${responseId}.` },
        { ...context, responseId, turnId: `turn-${responseId}` },
      );
      await ctx.core.commitResponse(responseId);
    }

    await expect(
      ctx.core.write(
        { command: "insert", file: "doc.md", content: "blocked." },
        { ...context, responseId: "response-1", turnId: "turn-blocked" },
      ),
    ).resolves.toMatchObject({ status: "invalid_write" });

    const reopened = await ctx.core.write(
      { command: "insert", file: "doc.md", content: "fresh." },
      { ...context, responseId: "response-0", turnId: "turn-fresh" },
    );
    expect(reopened.status).toBe("success");
    expect(reopened.text).toContain("fresh.");
  });
});
