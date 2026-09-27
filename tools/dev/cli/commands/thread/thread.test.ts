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

  it("also accepts full ids, app URLs, and unique id prefixes", async () => {
    expect((await mf(["thread", "view", "1111"])).code).toBe(EXIT.ok);
    expect((await mf(["thread", "view", `https://app.x/chat/${THREAD_ID}`])).code).toBe(EXIT.ok);
    expect((await mf(["thread", "view", "9999"])).code).toBe(EXIT.notFound);
  });

  it("creates a thread with the default agent", async () => {
    const result = await mf(["thread", "create", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ threadId: THREAD_ID, projectId: PROJECT_ID });
  });

  it("send waits, prints the answer on stdout and progress on stderr", async () => {
    const result = await mf(["thread", "send", THREAD_ID, "hi"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.trim()).toBe("Hello there");
    expect(result.stderr).toContain("turn.started");
    expect(result.stderr).toContain("assistant: Hello there");
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

  it("send --json --fields trims every stream line but keeps its type", async () => {
    const result = await mf([
      "thread",
      "send",
      THREAD_ID,
      "trim me",
      "--json",
      "--fields",
      "status,finalText",
    ]);
    expect(result.code).toBe(EXIT.ok);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ type: "result", status: "complete", finalText: "Hello there" });
    expect(lines[0]).toEqual({ type: "turn.started" });
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

  it("thread events replays the journal from a seq", async () => {
    const result = await mf(["thread", "events", THREAD_ID, "--json"]);
    expect(result.code).toBe(EXIT.ok);
    const types = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type);
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.finished");
  });

  it("thread events --name keeps only those events and gives custom ones a line", async () => {
    expect((await mf(["thread", "send", THREAD_ID, "delegate"])).code).toBe(EXIT.ok);
    const json = await mf([
      "thread",
      "events",
      THREAD_ID,
      "--name",
      "tool.completed,meridian.subagent.activity",
      "--json",
    ]);
    expect(json.code).toBe(EXIT.ok);
    const lines = json.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(new Set(lines.map((line) => (line.type === "event" ? line.name : line.type)))).toEqual(
      new Set(["tool.completed", "meridian.subagent.activity"]),
    );
    const text = await mf(["thread", "events", THREAD_ID, "--name", "meridian.subagent.activity"]);
    expect(text.stdout.trim().split("\n")).toHaveLength(3);
    expect(text.stdout).toMatch(/^\d+ meridian\.subagent\.activity \{"descendants":\[\]\}/);
  });

  it("thread events --child follows one descendant's status and current tool", async () => {
    const byRef = await mf(["thread", "events", THREAD_ID, "--child", "p2"]);
    expect(byRef.code).toBe(EXIT.ok);
    expect(byRef.stdout.trim().split("\n")).toEqual([
      expect.stringMatching(
        /^\d+ p2 awake\/generating \(running\) doc_read manuscript:\/\/ch1\.md$/,
      ),
      expect.stringMatching(/^\d+ p2 asleep \(succeeded\)$/),
    ]);
    const byId = await mf(["thread", "events", THREAD_ID, "--child", "33333333", "--json"]);
    expect(JSON.parse(byId.stdout.trim().split("\n")[0])).toMatchObject({
      type: "child.activity",
      threadId: THREAD_ID,
      childThreadId: "33333333-3333-4333-8333-333333333333",
      status: "awake",
      phase: "generating",
      tool: "doc_read",
      target: "manuscript://ch1.md",
    });
    const conflict = await mf(["thread", "events", THREAD_ID, "--child", "p2", "--name", "x"]);
    expect(conflict.code).toBe(EXIT.usage);
  });

  it("thread blocks lists persisted blocks with timing and tool names", async () => {
    const json = await mf(["thread", "blocks", THREAD_ID, "--last", "1", "--json"]);
    expect(json.code).toBe(EXIT.ok);
    const { blocks } = JSON.parse(json.stdout);
    expect(blocks).toEqual([
      expect.objectContaining({ sequence: 0, type: "tool_use", tool: "spawn", offsetMs: 500 }),
      expect.objectContaining({ sequence: 1, type: "tool_result", tool: "spawn", gapMs: 1500 }),
      expect.objectContaining({ sequence: 2, type: "text", tool: null, offsetMs: 3000 }),
    ]);
    const text = await mf(["thread", "blocks", THREAD_ID, "--last", "1"]);
    expect(text.stdout).toContain(
      "#1 2026-01-01T00:00:02.000Z +2.00s (gap 1.50s) tool_result spawn",
    );
  });

  it("thread view renders the transcript", async () => {
    const result = await mf(["thread", "view", THREAD_ID]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("[assistant]");
    expect(result.stdout).toContain("Hello there");
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
