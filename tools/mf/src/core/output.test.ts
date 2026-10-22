/** Terminal projection is identical for object results and NDJSON records. */
import { expect, it } from "vitest";
import { Output } from "./output";

it("retains terminal keys in object and stream output", () => {
  for (const mode of ["object", "stream"] as const)
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
