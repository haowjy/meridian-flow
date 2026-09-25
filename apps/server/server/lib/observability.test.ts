import { describe, expect, it } from "vitest";
import { runShutdownSteps } from "./observability.js";

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
