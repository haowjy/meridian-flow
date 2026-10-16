/**
 * `thread` commands against the wire harness: each test states the admission, snapshots, frames and
 * Stop answer it needs, and checks what ./mf posted and how it read them. Server policy is not tested here.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventType,
  MESSAGES_HANDED_BACK_EVENT,
  type SendMessageResponse,
} from "@meridian/contracts/protocol";
import { serializeMessageDoc } from "@meridian/thread-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { startWire, type Wire } from "../../test-support/wire";
import {
  DIVERGED_STORED_TEXT,
  DOCUMENT_ID,
  frames,
  inboxItem,
  ndjson,
  openReply,
  PROJECT_ID,
  publishRecord,
  recordOf,
  replyScenario,
  replyTurn,
  snapshotOf,
  THREAD_ID,
  userTurn,
} from "../../test-support/wire-fixtures";

let wire: Wire;
beforeEach(async () => {
  wire = await startWire();
});
afterEach(() => wire.close());

const lastRecord = (stdout: string) => ndjson(stdout).at(-1);
const tail = (...args: string[]) => wire.mf(["thread", "tail", THREAD_ID, ...args]);
const send = (text: string, ...rest: string[]) =>
  wire.mf(["thread", "send", THREAD_ID, text, ...rest]);

/** The message `u1` was admitted and a reply `a1` holds its execution open, with no frames. */
function runningReply() {
  wire.snapshot = snapshotOf({
    turns: [
      userTurn("u1", 1, "hang", "a1"),
      replyTurn("a1", 2, { prevTurnId: "u1", status: "streaming" }),
    ],
    record: { execution: { executionId: "exec-a1", currentTurnId: "a1" } },
  });
}

describe("thread send", () => {
  it("exits on a usage block proven for its own accepted message", async () => {
    wire.snapshot = snapshotOf({
      turns: [userTurn("u1", 1, "wait for usage")],
      record: {
        items: [inboxItem("u1", 1)],
        sentThrough: 1,
        blocked: { reason: "credits_exhausted" },
      },
    });
    const result = await send("wait for usage", "--timeout", "2s", "--json");
    expect(result.code).toBe(EXIT.failed);
    expect(lastRecord(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "credits_exhausted",
      turnId: null,
    });
  });

  it("uses the snapshot's outcome rather than an obsolete usage block in the replay", async () => {
    replyScenario(wire, { stored: "Recovered reply" });
    // The journal carries a blocked record from before the usage returned. It lands after the
    // admission's cursor is taken, so the client really replays it.
    const admit = wire.admit;
    wire.admit = (body) => {
      const resumeAfterSeq = String(wire.head);
      publishRecord(wire, {
        items: [inboxItem("u1", 1)],
        sentThrough: 1,
        blocked: { reason: "credits_exhausted" },
      });
      publishRecord(wire, { sentThrough: 1 });
      return { ...admit(body), resumeAfterSeq };
    };
    const result = await send("recovered before admission returns", "--timeout", "2s", "--json");
    // The obsolete blocked record did reach the CLI, and the newer snapshot still decides.
    expect(result.stdout).toContain('"blocked":{"reason":"credits_exhausted"}');
    expect(result.code).toBe(EXIT.ok);
    expect(lastRecord(result.stdout)).toMatchObject({
      type: "result",
      status: "complete",
      finalText: "Recovered reply",
      turnId: "a1",
    });
  });

  it("streams NDJSON ending in the result envelope, with its live view against the stored reply", async () => {
    replyScenario(wire, {});
    const result = await send("hi again", "--json");
    expect(result.code).toBe(EXIT.ok);
    // Only confirming snapshots (the subscribed state, then the closing record).
    expect(wire.reads).toBeLessThanOrEqual(2);
    const lines = ndjson(result.stdout);
    expect(lines.map((line) => line.type)).toContain("message.delta");
    expect(lines.at(-1)).toMatchObject({
      type: "result",
      command: "thread.send",
      outcome: "complete",
      reason: null,
      status: "complete",
      finalText: "Hello there",
      liveView: "matches",
    });
    expect(lines.at(-1)).not.toHaveProperty("liveDiff");
    expect(result.stderr).toBe("");
  });

  it("reports a reply stored differently from what streamed, never a different claim", async () => {
    replyScenario(wire, { streamed: ["Hello there"], stored: DIVERGED_STORED_TEXT });
    const json = await send("diverge", "--json");
    expect(json.code).toBe(EXIT.ok);
    expect(lastRecord(json.stdout)).toMatchObject({
      outcome: "complete",
      finalText: DIVERGED_STORED_TEXT,
      liveView: "differs",
      liveDiff: [{ field: "finalText", live: "Hello there", server: DIVERGED_STORED_TEXT }],
    });
    const text = await send("diverge");
    expect(text.code).toBe(EXIT.ok);
    expect(text.stderr.match(/live view differs from the server/g)).toHaveLength(1);
    expect(text.stderr).toContain("--full to show");
    const full = await send("diverge", "--full");
    expect(full.stderr).toContain(DIVERGED_STORED_TEXT);
    expect(full.stderr).not.toContain("--full to show");
  });

  it("resumes after a socket drop mid-run without duplicating the replay", async () => {
    wire.snapshot = snapshotOf({
      turns: [
        userTurn("u1", 1, "please reconnect", "a1"),
        replyTurn("a1", 2, { prevTurnId: "u1", status: "streaming" }),
      ],
      record: { execution: { executionId: "exec-a1", currentTurnId: "a1" } },
    });
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      wire.publish(frames.started("a1"));
      wire.dropSockets();
      await wire.until(() => wire.subscriptions >= 2);
      wire.snapshot = () =>
        snapshotOf({
          seq: wire.head,
          turns: [
            userTurn("u1", 1, "please reconnect", "a1"),
            replyTurn("a1", 2, { prevTurnId: "u1", text: "Hello there" }),
          ],
        });
      for (const event of frames.text("a1", "Hello", " there")) wire.publish(event);
      wire.publish(frames.finished("a1"));
      publishRecord(wire);
    });
    const result = await send("please reconnect", "--timeout", "3s", "--json");
    expect(result.code).toBe(EXIT.ok);
    const records = ndjson(result.stdout);
    const started = records.filter((record) => record.type === "turn.started");
    expect(started).toHaveLength(1);
    expect(
      records
        .filter((record) => record.type === "message.delta")
        .map((record) => record.text)
        .join(""),
    ).toBe("Hello there");
    expect(records.at(-1)).toMatchObject({ status: "complete", finalText: "Hello there" });
    // The reconnect asks for events after the last one it saw, not from the start again.
    const cursors = wire.clientMessages
      .filter((message) => message.type === "resume")
      .flatMap((message) => message.subscriptions as { lastSeq: string }[]);
    expect(cursors.at(-1)?.lastSeq).toBe(started[0].seq);
    expect(wire.connections).toBe(2);
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
    const result = await send(
      "Compare\nthis",
      "--skill",
      "revise",
      "--ref",
      "kb://cover.png",
      "--ref",
      "kb://cover.png",
      "--no-wait",
      "--json",
    );
    expect(result.code).toBe(EXIT.ok);
    expect(wire.bodiesOf("admit").at(-1)).toEqual({
      submissionId: expect.any(String),
      ...expected,
    });
  });

  it.each([
    ["error", EXIT.failed, "failed", { error: "boom" }],
    ["cancelled", EXIT.cancelled, "cancelled", {}],
    ["waiting_interrupt", EXIT.interrupt, "interrupt", {}],
  ] as const)("ends a %s run with exactly one result", async (status, code, outcome, fields) => {
    replyScenario(wire, { status });
    const result = await send("go", "--json");
    const records = ndjson(result.stdout);
    expect(result.code).toBe(code);
    expect(records.filter((record) => record.type === "result")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      type: "result",
      command: "thread.send",
      threadId: THREAD_ID,
      outcome,
      reason: null,
      ...fields,
    });
    if (status === "waiting_interrupt")
      expect((await send("go")).stderr).toContain("./mf thread respond");
  });

  it("queue hand-back --all posts every queued id and maps the scripted lists to output and an exit code", async () => {
    const [a, b, c] = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ];
    // Three queued messages behind a running reply; one of them was sent from a browser.
    wire.snapshot = snapshotOf({
      turns: [replyTurn("run", 1, { status: "streaming" })],
      record: {
        items: [inboxItem(a, 1, "first"), inboxItem(b, 2, "second"), inboxItem(c, 3, "third")],
        execution: { executionId: "exec-run", currentTurnId: "run" },
      },
    });
    wire.handBack = () => ({
      handedBack: [{ userTurnId: a, blocks: [{ type: "text", text: "first" }] }],
      answered: [b],
      gone: [],
      runState: recordOf(),
    });
    // A malformed answer is a lost one: the server may have acted, so the request is kept.
    wire.fail("handBack", { body: { handedBack: [{ userTurnId: a, blocks: [null] }] } });
    const lost = await wire.mf(["thread", "queue", "hand-back", THREAD_ID, "--all", "--json"]);
    expect(lost.code).toBe(EXIT.unavailable);
    const failure = JSON.parse(lost.stderr.trim().split("\n").at(-1) ?? "");
    expect(failure.hint).toContain("--replay");
    expect(failure.details.request).toEqual({ requestId: expect.any(String), ids: [a, b, c] });
    // Printed before posting, even under --json.
    expect(JSON.parse(lost.stderr.split("\n")[0] ?? "")).toMatchObject({
      type: "request",
      request: failure.details.request,
    });

    const replayed = await wire.mf([
      "thread",
      "queue",
      "hand-back",
      THREAD_ID,
      "--replay",
      JSON.stringify(failure.details.request),
      "--full",
      "--json",
    ]);
    // c was covered by none of the server's lists.
    expect(replayed.code).toBe(EXIT.failed);
    expect(lastRecord(replayed.stdout)).toMatchObject({
      command: "thread.queue.hand-back",
      outcome: "failed",
      reason: "not_a_message",
      handedBack: [{ userTurnId: a }],
      answered: [b],
      ignored: [c],
    });
    const posted = wire.bodiesOf("handBack");
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(failure.details.request);

    wire.handBack = () => ({
      handedBack: [{ userTurnId: a, blocks: [{ type: "text", text: "first" }] }],
      answered: [],
      gone: [b, c],
      runState: recordOf(),
    });
    const accounted = await wire.mf(["thread", "queue", "hand-back", THREAD_ID, "--all", "--full"]);
    expect(accounted.code).toBe(EXIT.ok);
    expect(accounted.stdout).toContain("first");
    expect(accounted.stderr).toContain("replay: ./mf thread queue hand-back");

    // Nothing queued: no request at all, and the claim is the snapshot's.
    wire.snapshot = snapshotOf();
    const before = wire.requestsOf("handBack").length;
    const empty = await wire.mf(["thread", "queue", "hand-back", THREAD_ID, "--all"]);
    expect(empty.code).toBe(EXIT.ok);
    expect(empty.stdout).toContain("nothing waits");
    expect(wire.requestsOf("handBack")).toHaveLength(before);

    // Missing or malformed run-state evidence is no proof: a failure, never "nothing waits" (QB1).
    for (const runState of [undefined, { version: "7" }]) {
      wire.snapshot = () => ({
        ...snapshotOf(),
        liveState: { ...snapshotOf().liveState, runState } as never,
      });
      for (const argv of [
        ["queue", "hand-back", THREAD_ID, "--all"],
        ["queue", "send-now", THREAD_ID],
        ["stop", THREAD_ID],
      ]) {
        const unread = await wire.mf(["thread", ...argv]);
        expect(unread.code).toBe(EXIT.failed);
        expect(unread.stdout).not.toMatch(/nothing/);
      }
    }
    expect(wire.requestsOf("handBack")).toHaveLength(before);

    // A definite refusal exits 1.
    wire.fail("handBack", { status: 409, body: { message: "other body" } });
    const refused = await wire.mf(["thread", "queue", "hand-back", THREAD_ID, "--id", a]);
    expect(refused.code).toBe(EXIT.failed);
  });

  it("queue send-now posts the body it built, words a null or a cancel, and prints the replay", async () => {
    const queued = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    wire.snapshot = snapshotOf({
      turns: [replyTurn("run", 1, { status: "streaming" })],
      record: {
        items: [inboxItem(queued, 1, "next")],
        sentThrough: 0,
        execution: { executionId: "exec-run", currentTurnId: "run" },
      },
    });
    const body = { seenThrough: 0, seenExecutionId: "exec-run", waiting: [queued] };
    wire.sendNow = () => ({
      threadId: THREAD_ID,
      cancelledExecutionId: "exec-run",
      runState: recordOf(),
    });
    const sent = await wire.mf(["thread", "queue", "send-now", THREAD_ID]);
    expect(sent.code).toBe(EXIT.ok);
    expect(sent.stdout).toContain("requested cancellation of exec-run");
    expect(sent.stdout).not.toContain("runs next");
    expect(wire.bodiesOf("sendNow")).toEqual([body]);
    // The body and the exact replay command are printed before posting.
    expect(sent.stderr).toContain(
      `replay: ./mf thread queue send-now ${THREAD_ID} --replay '${JSON.stringify(body)}'`,
    );

    // Null: this attempt requested no cancellation. It never claims the reply kept running.
    wire.sendNow = () => ({
      threadId: THREAD_ID,
      cancelledExecutionId: null,
      runState: recordOf(),
    });
    const none = await wire.mf(["thread", "queue", "send-now", THREAD_ID]);
    expect(none.code).toBe(EXIT.ok);
    expect(none.stdout).toContain("this attempt requested no cancellation");
    expect(none.stdout).not.toMatch(/kept running|still running/);

    // Not JSON, an answer missing its record, and an oversized answer are lost: exit 4 with the replay.
    wire.fail("sendNow", { text: "not JSON" });
    wire.fail("sendNow", { body: { threadId: THREAD_ID, cancelledExecutionId: null } });
    wire.fail("sendNow", { text: " ".repeat(20 * 1024 * 1024 + 1) });
    for (let lostAnswer = 0; lostAnswer < 3; lostAnswer++) {
      const lost = await wire.mf(["thread", "queue", "send-now", THREAD_ID, "--json"]);
      expect(lost.code).toBe(EXIT.unavailable);
      const failure = JSON.parse(lost.stderr.trim().split("\n").at(-1) ?? "");
      expect(failure.details.request).toEqual(body);
      expect(failure.hint).toContain(`--replay '${JSON.stringify(body)}'`);
    }
    // The replay re-sends the identical body with no new snapshot read.
    const readsBefore = wire.reads;
    const replayed = await wire.mf([
      "thread",
      "queue",
      "send-now",
      THREAD_ID,
      "--replay",
      JSON.stringify(body),
    ]);
    expect(replayed.code).toBe(EXIT.ok);
    expect(wire.reads).toBe(readsBefore);
    expect(wire.bodiesOf("sendNow").at(-1)).toEqual(body);

    wire.fail("sendNow", { status: 409, body: { message: "no" } });
    expect((await wire.mf(["thread", "queue", "send-now", THREAD_ID])).code).toBe(EXIT.failed);
  });

  it("ends on its message's hand-back with exit 5 and names the message", async () => {
    const queued = "queued for stop";
    wire.snapshot = snapshotOf({
      turns: [replyTurn("run", 1, { status: "streaming" }), userTurn("u1", 2, queued)],
      record: {
        items: [inboxItem("u1", 1, queued)],
        sentThrough: 1,
        execution: { executionId: "exec-run", currentTurnId: "run" },
      },
    });
    wire.stop = () => ({
      threadId: THREAD_ID,
      handedBack: [{ userTurnId: "u1", blocks: [{ type: "text", text: queued }] }],
      answered: [],
      gone: [],
      cancelledExecutionId: "exec-run",
      runState: recordOf(),
    });
    // The press lands (the snapshot and journal move on), but its first answer is unreadable.
    // None of these confirms the press: not JSON, a nested block that is not a block, and an
    // answer over the session's response limit. Each is a lost answer that keeps the request.
    const malformed = {
      ...wire.stop({} as never),
      handedBack: [{ userTurnId: "u1", blocks: [null] }],
    };
    wire.fail("stop", { text: "not JSON" });
    wire.fail("stop", { body: malformed });
    wire.fail("stop", { text: " ".repeat(20 * 1024 * 1024 + 1) });
    wire.play(async () => {
      await wire.until(() => wire.requestsOf("stop").length >= 1);
      wire.snapshot = () =>
        snapshotOf({ seq: wire.head, turns: [replyTurn("run", 1, { status: "cancelled" })] });
      wire.publish({
        type: "CUSTOM",
        name: MESSAGES_HANDED_BACK_EVENT,
        value: { userTurnIds: ["u1"] },
      } as never);
      publishRecord(wire);
    });
    const sending = send(queued);
    await wire.until(() => wire.requestsOf("admit").length > 0);
    let printed = "";
    for (let lostAnswer = 0; lostAnswer < 3; lostAnswer++) {
      const lost = await wire.mf(["thread", "stop", THREAD_ID, "--full", "--json"]);
      expect(lost.code).toBe(EXIT.unavailable);
      // Under --json the error itself carries the frozen request and the replay command.
      // (the request is also printed to stderr before posting, as the first line)
      const failure = JSON.parse(lost.stderr.trim().split("\n").at(-1) ?? "");
      expect(lost.stderr.split("\n")[0]).toContain(failure.details.request.requestId);
      expect(failure.hint).toContain("--replay");
      printed = JSON.stringify(failure.details.request);
      expect(failure.hint).toContain(printed);
    }
    const requestFile = join(await mkdtemp(join(tmpdir(), "mf-stop-")), "request.json");
    await writeFile(requestFile, printed ?? "");
    // The replay posts the identical request, with no new snapshot read.
    const readsBefore = wire.reads;
    const stopped = await wire.mf([
      "thread",
      "stop",
      THREAD_ID,
      "--replay",
      `@${requestFile}`,
      "--full",
    ]);
    expect(stopped.code).toBe(EXIT.ok);
    expect(stopped.stdout).toContain(queued);
    expect(wire.reads).toBe(readsBefore);
    // The shared Stop body: the record's watermark and execution, and no intents of ours.
    const posted = wire.bodiesOf("stop");
    expect(posted).toHaveLength(4);
    expect(posted[0]).toEqual({
      requestId: expect.any(String),
      seenThrough: 1,
      seenExecutionId: "exec-run",
      mine: [],
    });
    expect(posted[3]).toEqual(JSON.parse(printed));
    const result = await sending;
    expect(result.code).toBe(EXIT.cancelled);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "handed_back u1 (a Stop returned this message before any reply took it)",
    );
  });

  it("reports a failed successor, not the earlier reply's success", async () => {
    // Reply A took the message and completed; its execution continued into B, which failed.
    wire.snapshot = snapshotOf({
      turns: [
        userTurn("u1", 1, "go", "reply-earlier"),
        replyTurn("reply-earlier", 2, { executionId: "exec-1", text: "The earlier reply" }),
        replyTurn("reply-successor", 3, { executionId: "exec-1", status: "error", error: "boom" }),
      ],
    });
    const result = await send("go", "--json");
    expect(result.code).toBe(EXIT.failed);
    const last = lastRecord(result.stdout);
    expect(last).toMatchObject({
      outcome: "failed",
      userTurnId: "u1",
      answeredBy: "reply-earlier",
      turnId: "reply-successor",
      status: "error",
      error: "boom",
    });
    expect(last?.finalText ?? "").not.toContain("The earlier reply");
  });

  it("times out with exit 124 on the last snapshot, labelled stale, and starts no read at the deadline", async () => {
    runningReply();
    const result = await send("hang", "--timeout", "300ms", "--json");
    expect(result.code).toBe(EXIT.timeout);
    expect(lastRecord(result.stdout)).toMatchObject({
      type: "result",
      command: "thread.send",
      outcome: "timeout",
      reason: "running",
      stillRunning: { turnId: "a1", status: "streaming" },
      owed: [],
      next: expect.arrayContaining([expect.stringContaining("thread stop")]),
      status: "timeout",
      snapshotStale: true,
    });
    const text = await send("hang", "--timeout", "100ms");
    expect(text.stdout).toBe("");
    expect(text.stderr).toMatch(
      /timeout: last snapshot showed turn a1 streaming; current state is unconfirmed/,
    );
    expect(text.stderr).toContain("./mf thread stop");
    // Running out of time never presses Stop or Cancel.
    expect(wire.requestsOf("stop")).toHaveLength(0);
    expect(wire.requestsOf("cancel")).toHaveLength(0);

    // A snapshot still pending at the deadline: the timeout envelope reports it unavailable and
    // the deadline starts no further read.
    wire.fail("snapshot", { delayMs: 600 }, Number.POSITIVE_INFINITY);
    const readsBefore = wire.requestsOf("snapshot").length;
    const started = Date.now();
    const pending = await send("hang", "--timeout", "100ms", "--json");
    expect(pending.code).toBe(EXIT.timeout);
    expect(lastRecord(pending.stdout)).toMatchObject({
      outcome: "timeout",
      reason: "unconfirmed",
      snapshotUnavailable: true,
    });
    expect(wire.requestsOf("snapshot").length - readsBefore).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("is unproven, not timed out, when the snapshot shows the reply neither open nor finished", async () => {
    wire.snapshot = snapshotOf({
      turns: [
        userTurn("u1", 1, "hang", "a1"),
        replyTurn("a1", 2, { prevTurnId: "u1", status: "streaming" }),
      ],
    });
    const result = await send("hang", "--timeout", "100ms", "--json");
    expect(result.code).toBe(EXIT.unproven);
    expect(lastRecord(result.stdout)).toMatchObject({
      type: "result",
      outcome: "unproven",
      reason: "unconfirmed",
      stillRunning: null,
      owed: [],
    });
  });

  it("--mock queues a script scoped to the message text, then removes it", async () => {
    replyScenario(wire, {});
    const result = await send("scripted hi", "--mock", '[{"text":"ok"}]');
    expect(result.code).toBe(EXIT.ok);
    const [queued, removed] = wire.requestsOf("mock");
    expect(queued?.body).toEqual({ match: "scripted hi", steps: [{ text: "ok" }] });
    expect(removed).toMatchObject({ method: "DELETE", path: expect.stringContaining("script-1") });
  });

  it("keeps reserved terminal keys with --fields finalText", async () => {
    replyScenario(wire, {});
    const result = await send("hi", "--json", "--fields", "finalText");
    expect(result.code).toBe(EXIT.ok);
    expect(lastRecord(result.stdout)).toEqual({
      type: "result",
      command: "thread.send",
      outcome: "complete",
      reason: null,
      finalText: "Hello there",
    });
  });

  it.each([false, true])("names staged and committed writes honestly (json=%s)", async (json) => {
    replyScenario(wire, {
      extra: frames.toolCall("write-1", "doc_write", "{}", "staged", "committed"),
    });
    const result = await send("write tool", ...(json ? ["--json"] : []));
    expect(result.code).toBe(EXIT.ok);
    if (json) {
      const tools = ndjson(result.stdout).filter((record) => record.type.startsWith("tool."));
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
    ["accepted", EXIT.ok, "complete", null],
    ["rejected", EXIT.failed, "failed", null],
    ["not-seen", EXIT.failed, "failed", null],
    ["pending", EXIT.unproven, "unproven", "admission_unknown"],
    ["failed", EXIT.unproven, "unproven", "admission_unknown"],
  ] as const)("recovers a lost admission answer: %s", async (kind, code, outcome, reason) => {
    replyScenario(wire, {});
    const admit = wire.admit;
    let admitted: SendMessageResponse | undefined;
    wire.admit = (body) => (admitted = admit(body));
    wire.fail("admit", { drop: true });
    wire.lookup = (submissionId) => {
      if (kind === "accepted" && admitted) return { ...admitted, kind, submissionId };
      if (kind === "pending" || kind === "not-seen") return { kind, submissionId };
      return { kind: "rejected", submissionId, code: "refused" };
    };
    if (kind === "failed") wire.fail("lookup", { status: 503, body: { message: "lookup down" } });
    const result = await send("recover me", "--json");
    expect(result.code).toBe(code);
    expect(lastRecord(result.stdout)).toMatchObject({
      type: "result",
      command: "thread.send",
      outcome,
      reason,
    });
    expect(wire.requestsOf("admit")).toHaveLength(1);
  });

  it("--no-wait proves admission only, never complete", async () => {
    const result = await send("hi", "--no-wait", "--json");
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "thread.send",
      outcome: "accepted",
      reason: null,
    });
    expect(wire.subscriptions).toBe(0);
  });

  it("--no-wait also reports admission uncertainty", async () => {
    wire.fail("admit", { drop: true });
    wire.fail("lookup", { status: 503, body: { message: "lookup down" } });
    const result = await send("hi", "--no-wait", "--json");
    expect(result.code).toBe(EXIT.unproven);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "result",
      command: "thread.send",
      outcome: "unproven",
      reason: "admission_unknown",
      submissionId: expect.any(String),
    });
  });
});

describe("thread view, cancel, events, respond", () => {
  it("resolves cN refs through the by-ref route in the default or given project", async () => {
    wire.snapshot = snapshotOf({
      turns: [userTurn("u1", 1, "hi", "a1"), replyTurn("a1", 2, { text: "Hello there" })],
    });
    const byRef = await wire.mf(["thread", "view", "c1", "--json", "--fields", "thread"]);
    expect(byRef.code).toBe(EXIT.ok);
    expect(JSON.parse(byRef.stdout)).toEqual({
      thread: expect.objectContaining({ id: THREAD_ID, ref: "c1" }),
    });
    expect((await wire.mf(["thread", "view", "c1", "--project", PROJECT_ID])).code).toBe(EXIT.ok);
    // The envelope is the shared view model's rows, with what they were computed from.
    const envelope = JSON.parse((await wire.mf(["thread", "view", "c1", "--json"])).stdout);
    expect(envelope).toMatchObject({
      chatView: 2,
      inputs: { inherited: "omitted", localRecords: "none", standIns: "none", opening: "none" },
      cards: expect.any(Array),
    });
    expect(envelope.rows.length).toBeGreaterThan(0);
    for (const row of envelope.rows)
      expect(row.identity).toEqual({ turnId: row.renderKey, kind: row.kind, occurrence: 0 });
    const elsewhere = await wire.mf(["thread", "view", "c1", "--project", "other-project"]);
    expect(elsewhere.code).toBe(EXIT.notFound);
    expect(elsewhere.stderr).toContain("--project");
    expect((await wire.mf(["thread", "view", "c9"])).code).toBe(EXIT.notFound);
  });

  it.each([
    ["cancelled", EXIT.ok, "complete"],
    ["not_found", EXIT.notFound, "failed"],
  ] as const)("cancel answered %s emits one acknowledgement envelope and preserves its exit", async (status, code, outcome) => {
    wire.cancel = (turnId) => ({ threadId: THREAD_ID, turnId, status });
    const result = await wire.mf(["thread", "cancel", THREAD_ID, "--turn", "a1", "--json"]);
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "result",
      command: "thread.cancel",
      threadId: THREAD_ID,
      turnId: "a1",
      outcome,
      reason: null,
      status,
    });
    expect(wire.requestsOf("cancel")).toHaveLength(1);
  });

  it("prints gaps and finishes events only after replay and live state", async () => {
    replyScenario(wire, {});
    await send("hello");
    // The journal's retention starts at seq 1: a cursor below it is told what was skipped.
    wire.onSubscribe = (cursor) =>
      BigInt(cursor.lastSeq) < 1n
        ? {
            type: "gap",
            threadId: THREAD_ID,
            cause: "replay_limit_exceeded",
            fromSeq: cursor.lastSeq,
            toSeq: "1",
          }
        : undefined;
    const result = await wire.mf(["thread", "events", THREAD_ID, "--json"]);
    expect(result.code).toBe(EXIT.unproven);
    const records = ndjson(result.stdout);
    expect(records[0]).toEqual({
      type: "gap",
      threadId: THREAD_ID,
      cause: "replay_limit_exceeded",
      fromSeq: "0",
      toSeq: "1",
    });
    expect(records.map((record) => record.type)).not.toContain("turn.started");
    expect(records.map((record) => record.type)).toContain("turn.finished");
    expect(records.at(-1)).toMatchObject({
      type: "result",
      command: "thread.events",
      outcome: "unproven",
      reason: "replay_truncated",
    });
  });

  it.each([4401, 4403])("keeps terminal socket close %s at exit 4", async (code) => {
    wire.onSubscribe = () => ({ close: code });
    const result = await wire.mf(["thread", "events", THREAD_ID, "--timeout", "1s", "--json"]);
    expect(result.code).toBe(EXIT.unavailable);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "unavailable" });
  });

  it.each([
    ["resolved", EXIT.ok, "complete", null],
    ["unconfirmed", EXIT.unproven, "unproven", "unconfirmed"],
    ["other", EXIT.unproven, "unproven", "unconfirmed"],
    ["rejected", EXIT.failed, "failed", null],
  ] as const)("respond is confirmed only by its own interrupt (socket %s)", async (answer, code, outcome, reason) => {
    wire.onClient = (message, ws) => {
      if (message.type !== "interrupt.respond") return;
      if (answer === "rejected")
        ws.send(
          JSON.stringify({
            type: "error",
            kind: "error",
            threadId: THREAD_ID,
            error: {
              code: "interrupt_not_pending",
              message: "response rejected",
              retryable: false,
              source: "system",
            },
          }),
        );
      else if (answer !== "unconfirmed")
        wire.publish(frames.interrupt("a1", answer === "other" ? "other-id" : "int-1", "resolved"));
    };
    const result = await wire.mf([
      "thread",
      "respond",
      THREAD_ID,
      "--turn",
      "a1",
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
  });
});

describe("thread tail --until-idle", () => {
  it("follows both consecutive replies before confirming idle", async () => {
    // One execution answers the message in two replies; the record between them still owes it.
    wire.publish(frames.started("reply-first"));
    wire.publish(frames.finished("reply-first"));
    publishRecord(wire, { items: [inboxItem("u1", 1)], sentThrough: 1 });
    wire.publish(frames.started("reply-second"));
    wire.publish(frames.finished("reply-second"));
    publishRecord(wire, { sentThrough: 1 });
    const done = [
      replyTurn("reply-first", 1, { executionId: "exec-1" }),
      userTurn("u1", 2, "steer", "reply-second"),
      replyTurn("reply-second", 3, { executionId: "exec-1" }),
    ];
    wire.snapshot = (read) =>
      read === 1
        ? snapshotOf({
            turns: [
              replyTurn("reply-first", 1, { executionId: "exec-1", status: "streaming" }),
              userTurn("u1", 2, "steer", "reply-second"),
              replyTurn("reply-second", 3, { executionId: "exec-1", status: "pending" }),
            ],
            record: {
              items: [inboxItem("u1", 1)],
              sentThrough: 1,
              execution: { executionId: "exec-1", currentTurnId: "reply-first" },
            },
          })
        : snapshotOf({ seq: wire.head, turns: done, record: { sentThrough: 1 } });
    const result = await tail("--since", "0", "--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(EXIT.ok);
    const records = ndjson(result.stdout);
    expect(
      records.filter((record) => record.type === "turn.finished").map((record) => record.turnId),
    ).toEqual(["reply-first", "reply-second"]);
    expect(records.at(-1)).toMatchObject({
      type: "result",
      command: "thread.tail",
      outcome: "complete",
      reason: null,
      turnId: "reply-second",
    });
  });

  it("confirms the lease release after a turn finishes, not the turn alone", async () => {
    wire.snapshot = openReply("a1");
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      // The turn is done and the record idle, but the lease is still awake.
      wire.snapshot = () =>
        snapshotOf({ seq: wire.head, awake: true, turns: [replyTurn("a1", 1, { text: "Hi" })] });
      wire.publish(frames.started("a1"));
      wire.publish(frames.finished("a1"));
      publishRecord(wire);
      await new Promise((resolve) => setTimeout(resolve, 40));
      wire.snapshot = () =>
        snapshotOf({ seq: wire.head, turns: [replyTurn("a1", 1, { text: "Hi" })] });
      wire.publish({
        type: EventType.CUSTOM,
        name: "meridian.thread.status",
        value: { status: { kind: "asleep" }, runningTurnId: null },
      });
    });
    const result = await tail("--until-idle", "--timeout", "1s", "--json");
    expect(result.code).toBe(EXIT.ok);
    const records = ndjson(result.stdout);
    expect(records).toContainEqual(
      expect.objectContaining({ type: "event", name: "meridian.thread.status" }),
    );
    expect(records.at(-1)).toMatchObject({ outcome: "complete", reason: null, turnId: "a1" });
  });

  it("returns immediately on an already-idle chat", async () => {
    const result = await tail("--until-idle", "--timeout", "100ms", "--json");
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "result",
      command: "thread.tail",
      outcome: "complete",
      reason: null,
      threadId: THREAD_ID,
      turnId: null,
      turns: [],
      idle: true,
    });
    expect(result.stderr).toBe("");
    const text = await tail("--until-idle");
    expect(text.code).toBe(EXIT.ok);
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe("complete: chat idle, no turn ran during the wait\n");
    expect(wire.subscriptions).toBe(0);
  });

  it("reports a final timeout snapshot without stopping the run", async () => {
    wire.snapshot = openReply("a1");
    const result = await tail("--until-idle", "--timeout", "100ms", "--json");
    expect(result.code).toBe(EXIT.timeout);
    expect(lastRecord(result.stdout)).toMatchObject({
      type: "result",
      command: "thread.tail",
      outcome: "timeout",
      reason: "running",
      stillRunning: { status: "streaming" },
    });
    expect(wire.requestsOf("stop")).toHaveLength(0);
    expect(wire.requestsOf("cancel")).toHaveLength(0);
  });

  it("times out with an awake lease after an orphan error and empty inbox", async () => {
    wire.publish(frames.failed("orphaned"));
    publishRecord(wire, { version: "9999" });
    wire.snapshot = snapshotOf({
      seq: 2,
      awake: true,
      turns: [replyTurn("orphan-turn", 1, { status: "error", error: "orphaned" })],
    });
    const result = await tail("--since", "0", "--until-idle", "--timeout", "100ms", "--json");
    expect(result.code).toBe(EXIT.timeout);
    const records = ndjson(result.stdout);
    expect(records).toContainEqual(expect.objectContaining({ type: "turn.failed" }));
    expect(records).toContainEqual(
      expect.objectContaining({ type: "event", name: "meridian.run_state" }),
    );
    expect(records.at(-1)).toMatchObject({
      outcome: "timeout",
      reason: "lease_awake",
      stillRunning: null,
      owed: [],
      snapshotStale: true,
      next: [`./mf thread tail ${THREAD_ID} --until-idle`],
    });
    const text = await tail("--until-idle", "--timeout", "100ms");
    expect(text.code).toBe(EXIT.timeout);
    expect(text.stderr).toContain(
      "timeout: last snapshot showed no running turn or owed message, but the chat was awake; idle is unconfirmed",
    );
  });
});
