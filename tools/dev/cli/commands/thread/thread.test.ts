/** `thread` commands end to end against the fake stack: refs, send-and-wait outcomes, events, view. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import {
  type FakeStack,
  PROJECT_ID,
  startFakeStack,
  THREAD_ID,
} from "../../test-support/fake-stack";
import { composeMessage } from "./send";

let stack: FakeStack;
beforeAll(async () => {
  stack = await startFakeStack();
});
afterAll(() => stack.close());
const mf: FakeStack["mf"] = (argv, env) => stack.mf(argv, env);
const fake = {
  get mockScripts() {
    return stack.mockScripts;
  },
  get removedMockScripts() {
    return stack.removedMockScripts;
  },
};

describe("thread", () => {
  it("resolves cN refs through the by-ref route in the default or given project", async () => {
    const byRef = await mf(["thread", "view", "c1", "--json", "--fields", "thread"]);
    expect(byRef.code).toBe(EXIT.ok);
    expect(JSON.parse(byRef.stdout)).toEqual({
      thread: expect.objectContaining({ id: THREAD_ID, ref: "c1" }),
    });
    expect((await mf(["thread", "view", "c1", "--project", PROJECT_ID])).code).toBe(EXIT.ok);
    const elsewhere = await mf(["thread", "view", "c1", "--project", "other-project"]);
    expect(elsewhere.code).toBe(EXIT.notFound);
    expect(elsewhere.stderr).toContain("--project");
    expect((await mf(["thread", "view", "c9"])).code).toBe(EXIT.notFound);
  });

  it("send --json streams NDJSON whose last line is the result envelope", async () => {
    const result = await mf(["thread", "send", THREAD_ID, "hi again", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toContain("message.delta");
    expect(lines.at(-1)).toMatchObject({
      type: "result",
      status: "complete",
      finalText: "Hello there",
    });
    expect(result.stderr).toBe("");
  });

  it("send exits 1 on a failed run and 8 on a pending interrupt", async () => {
    const failed = await mf(["thread", "send", THREAD_ID, "please fail", "--json"]);
    expect(failed.code).toBe(EXIT.failed);
    expect(JSON.parse(failed.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      type: "error",
      status: "error",
      error: "boom",
    });
    const asked = await mf(["thread", "send", THREAD_ID, "ask me"]);
    expect(asked.code).toBe(EXIT.interrupt);
    expect(asked.stderr).toContain("./mf thread respond");
  });

  it("send waits for its queued reply after the running turn fails", async () => {
    const result = await mf(["thread", "send", THREAD_ID, "wait behind cancelled run", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      type: "result",
      status: "complete",
      finalText: "Answered the queued message",
    });
  });

  it("send times out with exit 124 instead of hanging", async () => {
    const result = await mf(["thread", "send", THREAD_ID, "hang", "--timeout", "300ms", "--json"]);
    expect(result.code).toBe(EXIT.timeout);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      status: "timeout",
    });
  });

  it("send --mock queues a script scoped to the message text, then removes it", async () => {
    const before = fake.mockScripts.length;
    const result = await mf([
      "thread",
      "send",
      THREAD_ID,
      "scripted hi",
      "--mock",
      '[{"text":"ok"}]',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(fake.mockScripts.slice(before)).toEqual([
      { match: "scripted hi", steps: [{ text: "ok" }] },
    ]);
    expect(fake.removedMockScripts).toContain(`script-${fake.mockScripts.length}`);
  });
});

describe("composeMessage", () => {
  it("keeps text equal to the concatenated block text, as admission requires", () => {
    const message = composeMessage({
      text: "Tighten this",
      skills: [{ slug: "line-edit", name: "Line edit", description: "d" }],
      references: [{ documentId: "d1", uri: "manuscript://chapter-2.md" }],
    });
    const blocks = message.blocks as { text?: string }[];
    expect(blocks.map((block) => block.text ?? "").join("")).toBe(message.text);
    expect(message.text).toBe("/line-edit Tighten this @manuscript://chapter-2.md");
    expect(message.references).toEqual([
      { documentId: "d1", uri: "manuscript://chapter-2.md", purpose: "reference" },
    ]);
    expect(message.activatedSkillSlugs).toEqual(["line-edit"]);
  });
});
