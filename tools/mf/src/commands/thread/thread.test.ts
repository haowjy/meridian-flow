/** `thread` commands end to end against the fake stack: refs, send-and-wait outcomes, events, view. */

import { serializeMessageDoc } from "@meridian/thread-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import {
  DOCUMENT_ID,
  type FakeStack,
  PROJECT_ID,
  startFakeStack,
  THREAD_ID,
} from "../../test-support/fake-stack";

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

  it.each([
    ["turn-a1", EXIT.ok, "complete", "cancelled"],
    ["missing", EXIT.notFound, "failed", "not_found"],
  ] as const)("cancel %s emits one acknowledgement envelope and preserves its exit", async (turnId, code, outcome, status) => {
    const isolated = await startFakeStack();
    try {
      await isolated.mf(["thread", "send", THREAD_ID, "hang", "--no-wait"]);
      const result = await isolated.mf(["thread", "cancel", THREAD_ID, "--turn", turnId, "--json"]);
      expect(result.code).toBe(code);
      expect(JSON.parse(result.stdout)).toEqual({
        type: "result",
        command: "thread.cancel",
        threadId: THREAD_ID,
        turnId,
        outcome,
        reason: null,
        status,
      });
    } finally {
      await isolated.close();
    }
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
      command: "thread.send",
      outcome: "complete",
      reason: null,
      status: "complete",
      finalText: "Hello there",
    });
    expect(result.stderr).toBe("");
  });

  it("resumes after a socket drop mid-run without duplicating the replay", async () => {
    const before = stack.resumeCursors.length;
    const result = await mf([
      "thread",
      "send",
      THREAD_ID,
      "please reconnect",
      "--timeout",
      "3s",
      "--json",
    ]);
    expect(result.code).toBe(EXIT.ok);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.type === "turn.started")).toHaveLength(1);
    expect(
      records
        .filter((record) => record.type === "message.delta")
        .map((record) => record.text)
        .join(""),
    ).toBe("Hello there");
    expect(records.at(-1)).toMatchObject({ status: "complete", finalText: "Hello there" });
    expect(stack.resumeCursors.slice(before)).toEqual([
      expect.any(String),
      records.find((record) => record.type === "turn.started").seq,
    ]);
  });

  it("admits a composer-shaped multiline message with a skill and multiple references", async () => {
    const reference = {
      documentId: DOCUMENT_ID,
      uri: "kb://cover.png",
      label: "Cover",
      imageCapable: true,
    };
    const expected = serializeMessageDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "composerSkill",
              attrs: { slug: "revise", name: "Revise", description: "Revise prose" },
            },
            { type: "text", text: "Compare" },
            { type: "hardBreak" },
            { type: "text", text: "this" },
            { type: "composerReference", attrs: { reference } },
            { type: "composerReference", attrs: { reference } },
          ],
        },
      ],
    });
    const result = await mf([
      "thread",
      "send",
      THREAD_ID,
      "Compare\nthis",
      "--skill",
      "revise",
      "--ref",
      "kb://cover.png",
      "--ref",
      "kb://cover.png",
      "--json",
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(stack.messageBodies.at(-1)).toEqual({ submissionId: expect.any(String), ...expected });
  });

  it("prints gaps and finishes events only after replay and live state", async () => {
    const isolated = await startFakeStack();
    try {
      await isolated.mf(["thread", "send", THREAD_ID, "hello"]);
      isolated.socketPolicy.replayFloor = "1";
      const result = await isolated.mf(["thread", "events", THREAD_ID, "--json"]);
      expect(result.code).toBe(EXIT.unproven);
      const records = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records[0]).toEqual({
        type: "gap",
        threadId: THREAD_ID,
        cause: "replay_limit_exceeded",
        fromSeq: "0",
        toSeq: "1",
      });
      expect(records.map((record) => record.type)).not.toContain("turn.started");
      expect(records.at(-2)).toMatchObject({ type: "turn.finished" });
      expect(records.at(-1)).toMatchObject({
        type: "result",
        command: "thread.events",
        outcome: "unproven",
        reason: "replay_truncated",
      });
    } finally {
      await isolated.close();
    }
  });

  it.each([4401, 4403])("keeps terminal socket close %s at exit 4", async (code) => {
    const isolated = await startFakeStack();
    try {
      isolated.socketPolicy.closeCode = code;
      const result = await isolated.mf([
        "thread",
        "events",
        THREAD_ID,
        "--timeout",
        "1s",
        "--json",
      ]);
      expect(result.code).toBe(EXIT.unavailable);
      expect(JSON.parse(result.stderr)).toMatchObject({ code: "unavailable" });
    } finally {
      await isolated.close();
    }
  });

  it("send exits 1 on a failed run and 8 on a pending interrupt", async () => {
    const failed = await mf(["thread", "send", THREAD_ID, "please fail", "--json"]);
    expect(failed.code).toBe(EXIT.failed);
    expect(JSON.parse(failed.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      type: "result",
      outcome: "failed",
      reason: null,
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

  it("send refuses complete while its steered message is still owed", async () => {
    const isolated = await startFakeStack();
    try {
      const result = await isolated.mf([
        "thread",
        "send",
        THREAD_ID,
        "steer behind completed run",
        "--json",
      ]);
      expect(result.code).toBe(EXIT.unproven);
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
        type: "result",
        command: "thread.send",
        outcome: "unproven",
        reason: "owed",
        stillRunning: { turnId: "reply-second", status: "streaming" },
        owed: [expect.objectContaining({ id: "turn-u1" })],
        next: [`./mf thread tail ${THREAD_ID} --until-idle`],
      });
    } finally {
      await isolated.close();
    }
  });

  it("send times out with exit 124 instead of hanging", async () => {
    const result = await mf(["thread", "send", THREAD_ID, "hang", "--timeout", "300ms", "--json"]);
    expect(result.code).toBe(EXIT.timeout);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
      type: "result",
      command: "thread.send",
      outcome: "timeout",
      reason: "running",
      stillRunning: { turnId: expect.any(String), status: "streaming" },
      owed: [],
      next: expect.arrayContaining([expect.stringContaining("thread cancel")]),
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
  it.each([
    ["cancelled", EXIT.cancelled, "cancelled"],
    ["ask", EXIT.interrupt, "interrupt"],
  ])("ends %s with exactly one result", async (text, code, outcome) => {
    const result = await mf(["thread", "send", THREAD_ID, String(text), "--json"]);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(result.code).toBe(code);
    expect(records.filter((record) => record.type === "result")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      type: "result",
      command: "thread.send",
      threadId: THREAD_ID,
      outcome,
      reason: null,
    });
  });

  it("keeps reserved terminal keys with --fields finalText", async () => {
    const result = await mf(["thread", "send", THREAD_ID, "hi", "--json", "--fields", "finalText"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      type: "result",
      command: "thread.send",
      outcome: "complete",
      reason: null,
      finalText: "Hello there",
    });
  });

  it.each([false, true])("names staged and committed writes honestly (json=%s)", async (json) => {
    const result = await mf([
      "thread",
      "send",
      THREAD_ID,
      "write tool",
      ...(json ? ["--json"] : []),
    ]);
    expect(result.code).toBe(EXIT.ok);
    if (json) {
      const tools = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((record) => record.type.startsWith("tool."));
      expect(tools.map((record) => record.type)).toEqual([
        "tool.started",
        "tool.completed",
        "tool.settled",
      ]);
      expect(tools.every((record) => !("settled" in record))).toBe(true);
    } else {
      expect(result.stderr).toMatch(/tool.completed[^\n]*staged[\s\S]*tool.settled[^\n]*committed/);
    }
  });

  it.each([
    ["resolved", EXIT.ok, "complete", null],
    ["unconfirmed", EXIT.unproven, "unproven", "unconfirmed"],
    ["other", EXIT.unproven, "unproven", "unconfirmed"],
    ["rejected", EXIT.failed, "failed", null],
  ] as const)("respond %s is confirmed only by its own interrupt", async (response, code, outcome, reason) => {
    const isolated = await startFakeStack();
    try {
      isolated.interruptPolicy.response = response;
      const result = await isolated.mf([
        "thread",
        "respond",
        THREAD_ID,
        "--turn",
        "turn-a1",
        "--interrupt",
        "int-1",
        "--value",
        "null",
        "--timeout",
        "100ms",
        "--json",
      ]);
      expect(result.code).toBe(code);
      expect(JSON.parse(result.stdout)).toMatchObject({
        type: "result",
        command: "thread.respond",
        outcome,
        reason,
      });
    } finally {
      await isolated.close();
    }
  });

  it.each([
    ["accepted", EXIT.ok, "complete", null],
    ["rejected", EXIT.failed, "failed", null],
    ["not-seen", EXIT.failed, "failed", null],
    ["pending", EXIT.unproven, "unproven", "admission_unknown"],
    ["failed", EXIT.unproven, "unproven", "admission_unknown"],
  ] as const)("recovers a lost admission answer: %s", async (lookup, code, outcome, reason) => {
    const isolated = await startFakeStack();
    try {
      isolated.admissionPolicy.loseAnswer = true;
      isolated.admissionPolicy.lookup = lookup;
      const result = await isolated.mf(["thread", "send", THREAD_ID, "recover me", "--json"]);
      expect(result.code).toBe(code);
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
        type: "result",
        command: "thread.send",
        outcome,
        reason,
      });
      expect(isolated.messageBodies).toHaveLength(1);
    } finally {
      await isolated.close();
    }
  });

  it("tail --until-idle reports a final timeout snapshot without stopping the run", async () => {
    const isolated = await startFakeStack();
    try {
      await isolated.mf(["thread", "send", THREAD_ID, "hang", "--no-wait"]);
      const result = await isolated.mf([
        "thread",
        "tail",
        THREAD_ID,
        "--until-idle",
        "--timeout",
        "100ms",
        "--json",
      ]);
      expect(result.code).toBe(EXIT.timeout);
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
        type: "result",
        command: "thread.tail",
        outcome: "timeout",
        reason: "running",
        stillRunning: { status: "streaming" },
      });
      const snapshot = await isolated.mf(["thread", "view", THREAD_ID, "--json"]);
      expect(snapshot.stdout).toContain("streaming");
    } finally {
      await isolated.close();
    }
  });
  it("timeout reports owed when no turn is running", async () => {
    const isolated = await startFakeStack();
    try {
      isolated.snapshotPolicy.running = false;
      const result = await isolated.mf([
        "thread",
        "send",
        THREAD_ID,
        "hang",
        "--timeout",
        "100ms",
        "--json",
      ]);
      expect(result.code).toBe(EXIT.timeout);
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
        type: "result",
        outcome: "timeout",
        reason: "owed",
        stillRunning: null,
        owed: [],
      });
    } finally {
      await isolated.close();
    }
  });

  it("timeout text says the server is still running and prints no answer", async () => {
    const result = await mf(["thread", "send", THREAD_ID, "hang", "--timeout", "100ms"]);
    expect(result.code).toBe(EXIT.timeout);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/timeout: turn .* still streaming on the server/);
    expect(result.stderr).toContain("stop it with ./mf thread cancel");
  });
  it.each([
    ["hi", EXIT.ok, "complete"],
    ["fail", EXIT.failed, "failed"],
    ["cancelled", EXIT.cancelled, "cancelled"],
  ] as const)("tail --until-idle ends %s with a result", async (text, code, outcome) => {
    const isolated = await startFakeStack();
    try {
      await isolated.mf(["thread", "send", THREAD_ID, text, "--no-wait"]);
      const result = await isolated.mf([
        "thread",
        "tail",
        THREAD_ID,
        "--since",
        "0",
        "--until-idle",
        "--json",
      ]);
      expect(result.code).toBe(code);
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
        type: "result",
        command: "thread.tail",
        outcome,
        reason: null,
      });
    } finally {
      await isolated.close();
    }
  });

  it("send --no-wait also reports admission uncertainty", async () => {
    const isolated = await startFakeStack();
    try {
      isolated.admissionPolicy.loseAnswer = true;
      isolated.admissionPolicy.lookup = "failed";
      const result = await isolated.mf(["thread", "send", THREAD_ID, "hi", "--no-wait", "--json"]);
      expect(result.code).toBe(EXIT.unproven);
      expect(JSON.parse(result.stdout)).toMatchObject({
        type: "result",
        command: "thread.send",
        outcome: "unproven",
        reason: "admission_unknown",
        submissionId: expect.any(String),
      });
    } finally {
      await isolated.close();
    }
  });
});
