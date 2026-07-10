// READ-REQUIRED fence behavior across staged and immediate model writes.
import { describe, expect, it } from "vitest";
import { context, harness } from "./test-support/write-tool-harness.js";

describe("READ-REQUIRED fence", () => {
  it.each([
    ["immediate", undefined],
    ["staged", "response-fenced"],
  ] as const)("rejects a %s write until the model reads", async (_mode, responseId) => {
    const ctx = harness({ "chapter.md": "Alpha." });
    ctx.core.setReadRequiredFence(context.sessionId, ["chapter.md"]);

    const fenced = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, ...(responseId ? { responseId } : {}) },
    );
    expect(fenced).toMatchObject({ status: "rejected_response_requires_reread", isError: true });
    expect(fenced.text).toContain('write(command="read", file="chapter.md")');

    await expect(
      ctx.core.write({ command: "read", file: "chapter.md" }, context),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      ctx.core.write(
        { command: "insert", file: "chapter.md", content: "Beta." },
        { ...context, ...(responseId ? { responseId } : {}) },
      ),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("crosses response IDs and is not cleared by create or requireSynced", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    ctx.core.setReadRequiredFence(context.sessionId, ["chapter.md"]);

    await ctx.core.write(
      { command: "create", file: "chapter.md", content: "Replacement.", overwrite: true },
      { ...context, responseId: "response-create" },
    );
    const differentResponse = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      { ...context, responseId: "response-new" },
    );
    expect(differentResponse.status).toBe("rejected_response_requires_reread");
  });

  it("is not cleared by a read that fails to select the requested content", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    ctx.core.setReadRequiredFence(context.sessionId, ["chapter.md"]);

    await expect(
      ctx.core.write({ command: "read", file: "chapter.md#missing-fragment" }, context),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      ctx.core.write({ command: "insert", file: "chapter.md", content: "Beta." }, context),
    ).resolves.toMatchObject({ status: "rejected_response_requires_reread" });
  });
});
