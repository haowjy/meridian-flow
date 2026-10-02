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
