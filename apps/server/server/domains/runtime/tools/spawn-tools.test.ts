/** Spawn-family registrations: advertised schemas, guidance copy and handler results. */
import { describe, expect, it, vi } from "vitest";
import { createSpawnToolRegistrations, spawnToolDescription } from "./spawn-tools.js";

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

  it("returns the reader's model result and refuses through the failure protocol", async () => {
    const registration = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "thread_report",
    );
    if (registration?.execution.type !== "server") throw new Error("missing thread_report");
    const report = {
      ref: "p3",
      outcome: "failed" as const,
      summary: "Stopped at the locked gate.",
      reason: "blocked",
      partial: true as const,
      running: true as const,
      message: "p3 is running again; this report is from its previous run.",
    };
    await expect(
      registration.execution.handler({ ref: "p3" }, {
        threadReport: vi.fn(async () => report),
      } as never),
    ).resolves.toEqual(report);
  });
});

describe("spawn tool guidance", () => {
  const spawn = createSpawnToolRegistrations().find(
    (entry) => entry.definition.name === "spawn",
  )?.definition;

  it("words the description for a named roster and for an empty one", () => {
    expect(spawnToolDescription(true)).toBe(
      "Run a subagent in its own thread. Prefer a named subagent from your roster; use the generic one sparingly. Background runs return immediately and notify you when they finish; if you have nothing else to do while waiting, end your turn. Don't message a child just to wait.",
    );
    expect(spawnToolDescription(false)).toBe(
      "Run a subagent in its own thread. You have no named subagents; spawn only when the user asks. Background runs return immediately and notify you when they finish; if you have nothing else to do while waiting, end your turn. Don't message a child just to wait.",
    );
  });

  it("labels the task apart from the agent and the source conversation apart from a document", () => {
    const properties = (
      spawn?.inputSchema as { properties: Record<string, { description?: string }> }
    ).properties;
    expect(properties.name?.description).toBe(
      '2–5 word task label the user sees, e.g. "Chapter 12 continuity check". Make parallel tasks distinct. Not the agent\'s name.',
    );
    expect(properties.from?.description).toBe(
      'A conversation ref, not a document (or "current"). The child can read it with thread_history; its history is not copied in.',
    );
  });

  it("describes return_result's report and payload", () => {
    const returnResult = createSpawnToolRegistrations().find(
      (entry) => entry.definition.name === "return_result",
    )?.definition;
    const properties = (
      returnResult?.inputSchema as { properties: Record<string, { description?: string }> }
    ).properties;
    expect(properties.summary?.description).toBe("Report for the parent.");
    expect(properties.payload?.description).toBe("Optional JSON result.");
  });
});
