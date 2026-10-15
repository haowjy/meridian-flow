/** Terminal projection is identical for object results and NDJSON records. */
import { expect, it } from "vitest";
import { Output, TERMINAL_KEYS } from "./output";

it("defines the reserved terminal keys once", () => {
  expect(TERMINAL_KEYS).toEqual(["type", "command", "outcome", "reason"]);
});

it.each(["object", "stream"] as const)("retains terminal keys in %s output", (mode) => {
  for (const fields of [
    ["finalText"],
    ["absent"],
    ["type"],
    ["command"],
    ["outcome"],
    ["reason"],
  ]) {
    let stdout = "";
    const out = new Output(
      {
        stdout: {
          write: (chunk) => {
            stdout += chunk;
          },
        },
        stderr: { write: () => true },
      },
      { json: true, fields },
    );
    const value = {
      type: "result",
      command: "thread.send",
      outcome: "unproven",
      reason: "owed",
      finalText: "reply",
      threadId: "t1",
    };
    if (mode === "object") out.result(value, () => "");
    else out.record(value, null, "err");
    expect(JSON.parse(stdout)).toEqual({
      type: "result",
      command: "thread.send",
      outcome: "unproven",
      reason: "owed",
      ...(fields.includes("finalText") ? { finalText: "reply" } : {}),
    });
  }
});
