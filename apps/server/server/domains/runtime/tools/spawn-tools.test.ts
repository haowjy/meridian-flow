/** Spawn/thread_message tool argument parsing and the advertised JSON schema. */
import { describe, expect, it, vi } from "vitest";
import { InvocationPatchError } from "../spawn/apply-invocation-patch.js";
import { createSpawnToolRegistrations, parseSpawnToolArgs } from "./spawn-tools.js";

describe("parseSpawnToolArgs", () => {
  it("keeps append_system_prompt and overrides when present and drops malformed values", () => {
    const args = parseSpawnToolArgs({
      agent: "critic",
      prompt: "review",
      description: "crit",
      mode: "foreground",
      append_system_prompt: "You are a harsh critic.",
      overrides: { tools: { edit: "allow" }, effort: "high" },
    });
    expect(args.append_system_prompt).toBe("You are a harsh critic.");
    expect(args.overrides).toEqual({ tools: { edit: "allow" }, effort: "high" });
    expect(parseSpawnToolArgs({ prompt: "go", append_system_prompt: 42 })).not.toHaveProperty(
      "append_system_prompt",
    );
    expect(parseSpawnToolArgs({ prompt: "go", overrides: "nope" })).not.toHaveProperty("overrides");
    expect(parseSpawnToolArgs({ prompt: "go", overrides: null })).not.toHaveProperty("overrides");
    expect(() => parseSpawnToolArgs({ prompt: "go", overrides: { effort: "invalid" } })).toThrow(
      InvocationPatchError,
    );
  });

  it("treats null from as absent and spawns without a reference source", async () => {
    const spawn = vi.fn(async (_args: Record<string, unknown>) => undefined);
    const registration = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "spawn",
    );
    if (registration?.execution.type !== "server") throw new Error("missing spawn");

    await registration.execution.handler({ prompt: "go", from: null }, { spawn } as never);

    expect(spawn).toHaveBeenCalledWith({ prompt: "go", mode: "foreground" });
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("from");
  });

  it.each([
    12,
    { ref: "c1" },
    ["c1"],
  ])("refuses malformed from %j without spawning", async (from) => {
    const spawn = vi.fn();
    const registration = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "spawn",
    );
    if (registration?.execution.type !== "server") throw new Error("missing spawn");
    expect(
      await registration.execution.handler({ prompt: "go", from }, { spawn } as never),
    ).toMatchObject({ ok: false, error: { code: "invalid_from" } });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("maps malformed nested patches before spawning", async () => {
    const spawn = vi.fn();
    const registration = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "spawn",
    );
    if (registration?.execution.type !== "server") throw new Error("missing spawn");
    const result = await registration.execution.handler(
      { prompt: "go", overrides: { effort: "invalid" } },
      { spawn } as never,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "spawn_invocation_patch_invalid" } });
    expect(spawn).not.toHaveBeenCalled();
  });
});

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
