/** Spawn-family registrations: advertised schemas, guidance copy and handler results. */
import { describe, expect, it, vi } from "vitest";
import { createSpawnToolRegistrations } from "./spawn-tools.js";

describe("thread_report tool contract", () => {
  it("reads the latest report by ref, with no run argument", () => {
    const registration = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "thread_report",
    );
    expect(registration?.capability).toBe("thread_report");
    expect(registration?.advertise).toBe(true);
    expect(registration?.definition.inputSchema).toEqual({
      type: "object",
      properties: {
        ref: {
          type: "string",
          minLength: 1,
          description: 'Subagent ref such as p3, or "current".',
        },
      },
      required: ["ref"],
      additionalProperties: false,
    });
    expect(registration?.definition.description).toContain("Does not wait");
  });

  it("returns only the model-facing report fields and non-default extras", async () => {
    const registration = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "thread_report",
    );
    if (registration?.execution.type !== "server") throw new Error("missing thread_report");
    const threadReport = vi.fn(async () => ({
      childThreadId: "internal-id",
      ref: "p3",
      run: 2,
      outcome: "failed" as const,
      deliveryMode: "background_notification" as const,
      source: "final_assistant" as const,
      summary: "Stopped at the locked gate.",
      payload: { gate: "locked" },
      artifacts: [],
      partial: true,
      reason: "blocked",
    }));

    await expect(
      registration.execution.handler({ ref: "p3" }, { threadReport } as never),
    ).resolves.toEqual({
      ref: "p3",
      run: 2,
      outcome: "failed",
      summary: "Stopped at the locked gate.",
      payload: { gate: "locked" },
      reason: "blocked",
      source: "final_assistant",
    });
  });
});

describe("spawn tool guidance", () => {
  const spawn = createSpawnToolRegistrations().find(
    (entry) => entry.definition.name === "spawn",
  )?.definition;

  it("keeps the behavior-critical turn and naming rules", () => {
    expect(spawn?.description).toContain("end your turn");
    expect(spawn?.description).toContain("Don't message a child just to wait");
    expect(JSON.stringify(spawn?.inputSchema)).toContain("2 to 5 words");
    expect(JSON.stringify(spawn?.inputSchema)).toContain("not copied in");
  });
});

describe("return_result tool contract", () => {
  const registration = createSpawnToolRegistrations().find(
    (entry) => entry.definition.name === "return_result",
  );

  it("advertises URI string artifact items and resolves them to object refs", async () => {
    const returnResult = vi.fn(async () => ({ ok: true as const }));
    if (registration?.execution.type !== "server") throw new Error("missing return_result");

    const properties = registration.definition.inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    expect(properties?.artifacts).toEqual({
      type: "array",
      description: "Meridian document URIs produced by this child.",
      items: { type: "string" },
    });
    await registration.execution.handler(
      {
        summary: "done",
        artifacts: ["scratch://the-lamplighters-arithmetic.md"],
      },
      { returnResult } as never,
    );

    expect(returnResult).toHaveBeenCalledWith({
      summary: "done",
      payload: undefined,
      artifacts: [{ type: "object", uri: "scratch://the-lamplighters-arithmetic.md" }],
    });
  });

  it.each([
    ["HTTP URL", "https://example.test/cover.png"],
    ["non-URI string", "not a Meridian URI"],
    ["typed artifact object", { type: "object", uri: "scratch://draft.md" }],
  ])("returns a tool error for a %s without invoking capture", async (_label, artifact) => {
    const returnResult = vi.fn(async () => ({ ok: true as const }));
    if (registration?.execution.type !== "server") throw new Error("missing return_result");

    const result = await registration.execution.handler(
      { summary: "done", artifacts: [artifact] },
      { returnResult } as never,
    );

    expect(result).toMatchObject({
      isError: true,
      output: {
        code: "tool_error",
        message: expect.stringContaining("artifacts[0]"),
      },
    });
    if (typeof artifact === "string") {
      expect(result).toMatchObject({ output: { message: expect.stringContaining(artifact) } });
    }
    expect(returnResult).not.toHaveBeenCalled();
  });
});
