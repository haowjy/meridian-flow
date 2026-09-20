/**
 * The pure terminal→result cascade and the one report builder. These pin the
 * branch table that the driver relies on: captured wins, then cancelled, error,
 * completed-without-capture, and a missing terminal event.
 */
import { describe, expect, it } from "vitest";
import { buildAgentReport, resolveSpawnResult } from "./child-run-driver.js";

const identity = { handle: "p3", threadId: "child-1" };

describe("buildAgentReport", () => {
  it("folds identity, capture, cost, and the incomplete flag", () => {
    const report = buildAgentReport({
      ...identity,
      capture: { summary: "done", payload: { saved: true } },
      costMillicredits: 42,
      incomplete: true,
    });
    expect(report).toEqual({
      handle: "p3",
      threadId: "child-1",
      summary: "done",
      payload: { saved: true },
      costMillicredits: 42,
      incomplete: true,
    });
  });

  it("omits an absent payload and incomplete flag", () => {
    const report = buildAgentReport({
      ...identity,
      capture: { summary: "done" },
      costMillicredits: 0,
    });
    expect(report).toEqual({
      handle: "p3",
      threadId: "child-1",
      summary: "done",
      costMillicredits: 0,
    });
  });
});

describe("resolveSpawnResult", () => {
  it("prefers the captured report over the terminal event", () => {
    const resolved = resolveSpawnResult({
      terminal: { type: "cancelled" },
      captured: { summary: "done" },
      ...identity,
      costMillicredits: 7,
    });
    expect(resolved.terminalStatus).toBe("succeeded");
    expect(resolved.spawnResult).toEqual({
      status: "completed",
      report: {
        handle: "p3",
        threadId: "child-1",
        summary: "done",
        costMillicredits: 7,
      },
    });
  });

  it("maps a cancelled terminal", () => {
    const resolved = resolveSpawnResult({
      terminal: { type: "cancelled" },
      captured: undefined,
      ...identity,
      costMillicredits: 0,
    });
    expect(resolved.terminalStatus).toBe("cancelled");
    expect(resolved.spawnResult.status).toBe("error");
    if (resolved.spawnResult.status === "error") {
      expect(resolved.spawnResult.error.code).toBe("spawn_cancelled");
    }
  });

  it("maps an error terminal, preserving its code and message", () => {
    const resolved = resolveSpawnResult({
      terminal: { type: "error", message: "boom", code: "provider_error" },
      captured: undefined,
      ...identity,
      costMillicredits: 0,
    });
    expect(resolved.terminalStatus).toBe("failed");
    if (resolved.spawnResult.status === "error") {
      expect(resolved.spawnResult.error.code).toBe("provider_error");
      expect(resolved.spawnResult.error.message).toBe("boom");
    }
  });

  it("falls back to spawn_failed for an empty error terminal", () => {
    const resolved = resolveSpawnResult({
      terminal: { type: "error", message: "", code: "" },
      captured: undefined,
      ...identity,
      costMillicredits: 0,
    });
    if (resolved.spawnResult.status === "error") {
      expect(resolved.spawnResult.error.code).toBe("spawn_failed");
      expect(resolved.spawnResult.error.message).toBe("Child run failed");
    }
  });

  it("uses the caller's incomplete report for a completed run without capture", () => {
    const incompleteReport = {
      handle: "p3",
      threadId: "child-1",
      summary: "last words",
      costMillicredits: 5,
      incomplete: true,
    };
    const resolved = resolveSpawnResult({
      terminal: { type: "completed" },
      captured: undefined,
      ...identity,
      costMillicredits: 5,
      incompleteReport,
    });
    expect(resolved.terminalStatus).toBe("succeeded");
    expect(resolved.spawnResult).toEqual({ status: "completed", report: incompleteReport });
  });

  it("rejects a completed terminal without an incomplete report", () => {
    expect(() =>
      resolveSpawnResult({
        terminal: { type: "completed" },
        captured: undefined,
        ...identity,
        costMillicredits: 0,
      }),
    ).toThrow(/incomplete report/);
  });

  it("maps a missing terminal event", () => {
    const resolved = resolveSpawnResult({
      terminal: null,
      captured: undefined,
      ...identity,
      costMillicredits: 0,
    });
    expect(resolved.terminalStatus).toBe("failed");
    if (resolved.spawnResult.status === "error") {
      expect(resolved.spawnResult.error.code).toBe("spawn_failed");
    }
  });
});
