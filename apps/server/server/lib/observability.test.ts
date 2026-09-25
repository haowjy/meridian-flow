import { describe, expect, it } from "vitest";
import { flushBeforeDeadline, runShutdownSteps } from "./observability.js";

describe("shutdown step sequencing", () => {
  it("runs named shutdown steps in order and stops after a deadline result", async () => {
    const visited: string[] = [];
    await runShutdownSteps(
      [
        { name: "stop-admission", callback: () => undefined },
        { name: "drain-sockets", callback: () => undefined },
        { name: "close-database", callback: () => undefined },
      ],
      async ({ name }) => {
        visited.push(name);
        return name !== "drain-sockets";
      },
    );

    expect(visited).toEqual(["stop-admission", "drain-sockets"]);
  });
});

describe("shutdown observability flush", () => {
  it("bounds a flush by the remaining shutdown budget", async () => {
    await expect(flushBeforeDeadline(() => new Promise(() => {}), 1)).resolves.toEqual({
      status: "deadline",
    });
    await expect(flushBeforeDeadline(async () => {}, 100)).resolves.toEqual({
      status: "flushed",
    });
    await expect(
      flushBeforeDeadline(() => Promise.reject(new Error("sink failed")), 100),
    ).resolves.toMatchObject({ status: "failed", error: { message: "sink failed" } });
  });
});
