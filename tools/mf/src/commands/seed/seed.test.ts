/** Seed retains every send's terminal claim and exits with the worst observed outcome. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { startFakeStack } from "../../test-support/fake-stack";

it("does not let a later complete send hide an earlier failed send", async () => {
  const stack = await startFakeStack();
  const dir = mkdtempSync(path.join(tmpdir(), "mf-seed-"));
  const fixture = path.join(dir, "scenario.json");
  writeFileSync(
    fixture,
    JSON.stringify({ thread: {}, messages: [{ text: "fail" }, { text: "hi" }] }),
  );
  try {
    const result = await stack.mf(["seed", fixture, "--json"]);
    expect(result.code).toBe(EXIT.failed);
    const record = JSON.parse(result.stdout);
    expect(record).toMatchObject({
      type: "result",
      command: "seed",
      outcome: "failed",
      reason: null,
    });
    expect(record.messages).toMatchObject([
      { type: "result", command: "thread.send", outcome: "failed", reason: null },
      { type: "result", command: "thread.send", outcome: "complete", reason: null },
    ]);
  } finally {
    await stack.close();
    rmSync(dir, { recursive: true });
  }
});
