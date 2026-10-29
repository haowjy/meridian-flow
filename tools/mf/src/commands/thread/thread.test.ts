/**
 * `thread` commands against the wire harness: each test states the admission, snapshots, frames and
 * Stop answer it needs, and checks what ./mf posted and how it read them. Server policy is not tested here.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - CLI request assembly and live-view exit policy (kb/decisions/engineering/dev-cli/mf-claims-are-proofs.md)
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventType,
  MESSAGES_HANDED_BACK_EVENT,
  type SendMessageResponse,
} from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../core/cli-error";
import { startWire, type Wire } from "../../test-support/wire";
import {
  COOKIE,
  DIVERGED_STORED_TEXT,
  frames,
  inboxItem,
  ndjson,
  openReply,
  publishRecord,
  recordOf,
  replyScenario,
  replyTurn,
  snapshotOf,
  THREAD_ID,
  userTurn,
} from "../../test-support/wire-fixtures";
import { createThreadClient, subscribeThread } from "./transport";

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
  it("assembles CLI skills and repeated refs from address lookups into the admission", async () => {
    wire.fail("other", {
      body: { skills: [{ slug: "revise", name: "Revise", description: "Revise prose" }] },
    });
    wire.fail("other", {
      body: {
        kind: "current",
        document: {
          kind: "available",
          documentId: "notes-id",
          generation: "1",
          authority: { kind: "project", projectId: "22222222-2222-4222-8222-222222222222" },
          entry: {
            kind: "file",
            observationVersion: "1",
            entryId: "entry",
            scope: { kind: "project", projectId: "22222222-2222-4222-8222-222222222222" },
            sourceId: "source",
            parentId: "root",
            aliases: [],
            path: ["notes"],
            uri: "kb://notes",
            provisionalName: false,
            name: "Notes",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        },
      },
    });
    wire.fail("other", {
      body: {
        kind: "current",
        document: {
          kind: "available",
          documentId: "image-id",
          generation: "1",
          authority: { kind: "project", projectId: "22222222-2222-4222-8222-222222222222" },
          entry: {
            kind: "file",
            observationVersion: "1",
            entryId: "entry",
            scope: { kind: "project", projectId: "22222222-2222-4222-8222-222222222222" },
            sourceId: "source",
            parentId: "root",
            aliases: [],
            path: ["cover.png"],
            uri: "kb://cover.png",
            provisionalName: false,
            name: "Cover",
            editable: false,
            disposition: "binary",
            fileType: "image",
            mimeType: "image/png",
          },
        },
      },
    });
    const result = await send(
      "Compare\nthese",
      "--skill",
      "revise",
      "--ref",
      "kb://notes.md",
      "--ref",
      "kb://cover.png",
      "--no-wait",
      "--json",
    );
    expect(result.code).toBe(EXIT.ok);
    expect(wire.requestsOf("other").map((request) => request.path)).toEqual([
      `/api/threads/${THREAD_ID}/skills`,
      "/api/projects/22222222-2222-4222-8222-222222222222/context/kb/address?path=notes",
      "/api/projects/22222222-2222-4222-8222-222222222222/context/kb/address?path=cover.png",
    ]);
    expect(wire.bodiesOf("admit")).toEqual([
      {
        submissionId: expect.any(String),
        text: "/reviseCompare\nthese[Notes](kb://notes)[Cover](kb://cover.png)",
        activatedSkillSlugs: ["revise"],
        references: [
          {
            kind: "document",
            documentId: "notes-id",
            uri: "kb://notes",
            purpose: "reference",
          },
          {
            kind: "document",
            documentId: "image-id",
            uri: "kb://cover.png",
            purpose: "reference",
          },
        ],
        blocks: [
          {
            type: "skill",
            text: "/revise",
            slug: "revise",
            name: "Revise",
            description: "Revise prose",
          },
          { type: "text", text: "Compare\nthese" },
          {
            type: "reference",
            kind: "document",
            text: "[Notes](kb://notes)",
            documentId: "notes-id",
            uri: "kb://notes",
          },
          {
            type: "reference",
            kind: "document",
            text: "[Cover](kb://cover.png)",
            documentId: "image-id",
            uri: "kb://cover.png",
          },
          { type: "image", documentId: "image-id", uri: "kb://cover.png" },
        ],
      },
    ]);
  });

  it("uses the snapshot's outcome rather than an obsolete usage block in the replay", async () => {
    // The journal carries a blocked record from before the usage returned. It sits above the join
    // read's cursor, so the client really replays it.
    replyScenario(wire, {
      stored: "Recovered reply",
      lead: () => {
        publishRecord(wire, {
          items: [inboxItem("u1", 1)],
          sentThrough: 1,
          blocked: { reason: "credits_exhausted" },
        });
        publishRecord(wire, { sentThrough: 1 });
      },
    });
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

  it("reports a reply stored differently from what streamed, never a different claim", async () => {
    replyScenario(wire, { streamed: ["Hello there"], stored: DIVERGED_STORED_TEXT });
    const json = await send("diverge", "--json");
    expect(json.code).toBe(EXIT.ok);
    expect(lastRecord(json.stdout)).toMatchObject({
      outcome: "complete",
      finalText: DIVERGED_STORED_TEXT,
      liveView: "differs",
      liveDiff: [
        { turnId: "a1", field: "finalText", live: "Hello there", server: DIVERGED_STORED_TEXT },
      ],
    });
    const text = await send("diverge");
    expect(text.code).toBe(EXIT.ok);
    expect(text.stderr.match(/live view differs from the server/g)).toHaveLength(1);
    expect(text.stderr).toContain("--full to show");
    const full = await send("diverge", "--full");
    expect(full.stderr).toContain(DIVERGED_STORED_TEXT);
    expect(full.stderr).not.toContain("--full to show");
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
    const abortedBefore = wire.aborted.filter((request) => request.kind === "snapshot").length;
    const pending = await send("hang", "--timeout", "100ms", "--json");
    expect(pending.code).toBe(EXIT.timeout);
    expect(lastRecord(pending.stdout)).toMatchObject({
      outcome: "timeout",
      reason: "unconfirmed",
      snapshotUnavailable: true,
    });
    expect(wire.requestsOf("snapshot").length - readsBefore).toBe(1);
    await wire.until(
      () => wire.aborted.filter((request) => request.kind === "snapshot").length > abortedBefore,
    );
    expect(
      wire.aborted.filter((request) => request.kind === "snapshot").length - abortedBefore,
    ).toBe(1);
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

  it("names staged and committed writes honestly", async () => {
    replyScenario(wire, {
      extra: frames.toolCall("write-1", "doc_write", "{}", "staged", "committed"),
    });
    const result = await send("write tool", "--json");
    expect(result.code).toBe(EXIT.ok);
    const tools = ndjson(result.stdout).filter((record) => record.type.startsWith("tool."));
    expect(tools.map((record) => record.type)).toEqual([
      "tool.started",
      "tool.completed",
      "tool.settled",
    ]);
    expect(tools.every((record) => !("settled" in record))).toBe(true);
  });

  it.each([
    ["accepted", EXIT.ok, "complete", null],
    ["failed", EXIT.unproven, "unproven", "admission_unknown"],
  ] as const)("recovers a lost admission answer: %s", async (kind, code, outcome, reason) => {
    replyScenario(wire, {});
    const admit = wire.admit;
    let admitted: SendMessageResponse | undefined;
    wire.admit = (body) => (admitted = admit(body));
    wire.fail("admit", { drop: true });
    wire.lookup = (submissionId) => {
      if (kind === "accepted" && admitted) return { ...admitted, kind, submissionId };
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

  it.each([
    "delayed",
    "empty",
  ] as const)("keeps a proven send when its diagnostic read is %s", async (fault) => {
    // The first read joins with the reply running; the next shows it complete and proves the claim
    // while the stream has not yet ended the turn. Then a frame makes the sync start one more read,
    // which the harness holds for 5 s or answers with an empty body.
    wire.snapshot = (read) => {
      if (read === 1)
        return snapshotOf({
          seq: 0,
          turns: [
            userTurn("u1", 1, "hold", "a1"),
            replyTurn("a1", 2, { prevTurnId: "u1", status: "streaming" }),
          ],
          record: { execution: { executionId: "exec-a1", currentTurnId: "a1" } },
        });
      return snapshotOf({
        seq: wire.head,
        turns: [
          userTurn("u1", 1, "hold", "a1"),
          replyTurn("a1", 2, { prevTurnId: "u1", text: "Hello there" }),
        ],
      });
    };
    wire.play(async () => {
      await wire.until(() => wire.subscriptions >= 1);
      wire.publish(frames.started("a1"));
      publishRecord(wire);
      await wire.until(() => wire.reads >= 2);
      // Let the proving answer leave, so the held fault is for the read after it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      wire.fail("snapshot", fault === "delayed" ? { delayMs: 5000 } : { status: 204, text: "" });
      wire.publish(frames.finished("a1"));
    });
    const result = await send("hold", "--timeout", "10s", "--json");
    expect(result.code).toBe(EXIT.ok);
    expect(lastRecord(result.stdout)).toMatchObject({
      outcome: "complete",
      finalText: "Hello there",
    });
    if (fault === "delayed") {
      // The command ended with a read still open: the harness saw the client close it.
      await wire.until(() => wire.aborted.some((request) => request.kind === "snapshot"));
    } else {
      expect(lastRecord(result.stdout)).toMatchObject({ observationIncomplete: true });
    }
    expect(result.stderr).toBe("");
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
});

describe("thread view, cancel, events, answer", () => {
  it("rejects an object-valued reply error instead of printing it as text", async () => {
    const snapshot = snapshotOf({ turns: [replyTurn("a1", 1, { status: "error" })] });
    wire.fail("snapshot", {
      body: {
        ...snapshot,
        turns: [{ ...snapshot.turns[0], error: { message: "not a string" } }],
      },
    });
    const result = await wire.mf(["thread", "view", THREAD_ID]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid response");
  });

  it("rejects a malformed cancel answer without claiming completion", async () => {
    wire.fail("cancel", { status: 200, body: {} });
    const result = await wire.mf(["thread", "cancel", THREAD_ID, "--turn", "a1", "--json"]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "http_error" });
  });

  it("prints gaps and finishes events only after replay and live state", async () => {
    replyScenario(wire, {});
    await send("hello");
    // The journal's retention starts at seq 1: a cursor below it is told what was skipped.
    wire.onSubscribe = (cursor) =>
      BigInt(cursor.lastSeq) < 1n
        ? {
            type: "gap",
            requestId: cursor.requestId,
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

  it.each([
    "events",
    "send",
    "tail",
  ] as const)("keeps %s terminal socket close 4401 at exit 4", async (command) => {
    runningReply();
    wire.onSubscribe = () => ({ close: 4401 });
    const args = command === "send" ? ["hang"] : command === "tail" ? ["--until-idle"] : [];
    const result = await wire.mf([
      "thread",
      command,
      THREAD_ID,
      ...args,
      "--timeout",
      "1s",
      "--json",
    ]);
    expect(result.code).toBe(EXIT.unavailable);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "unavailable" });
  });
});

describe("thread tail --until-idle", () => {
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
});

describe("replay outcomes", () => {
  it.each([
    "send",
    "tail",
    "events",
  ] as const)("%s recovers retryable errors but ends on a refusal", async (command) => {
    runningReply();
    let attempts = 0;
    wire.onSubscribe = (cursor) => {
      attempts += 1;
      return {
        type: "error",
        kind: "error",
        requestId: cursor.requestId,
        threadId: cursor.threadId,
        error: {
          code: "internal",
          source: "system",
          message: attempts === 1 ? "temporary read failure" : "refused replay",
          retryable: attempts === 1,
        },
      };
    };
    const args = command === "send" ? ["hang"] : command === "tail" ? ["--until-idle"] : [];
    const result = await wire.mf([
      "thread",
      command,
      THREAD_ID,
      ...args,
      "--timeout",
      "2s",
      "--json",
    ]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.stderr).toContain("refused replay");
    expect(result.stdout).not.toContain('"outcome":"complete"');
    expect(attempts).toBe(2);
    expect(wire.connections).toBe(1);
    const requests = wire.clientMessages.filter((message) => message.type === "subscribe");
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
  });
});

it("keeps a sibling live on the same socket while a replay retries", async () => {
  let attempts = 0;
  wire.onSubscribe = (cursor) => {
    if (cursor.threadId !== "failed-thread") return;
    attempts += 1;
    if (attempts !== 1) return;
    return {
      type: "error",
      kind: "error",
      requestId: cursor.requestId,
      threadId: cursor.threadId,
      error: { code: "internal", source: "system", message: "try again", retryable: true },
    };
  };
  const transport = createThreadClient({
    serverUrl: wire.baseUrl,
    cookie: COOKIE,
    ca: undefined,
    request: async () => {
      throw new Error("no HTTP expected");
    },
  });
  const healthy = subscribeThread(transport, THREAD_ID, "0");
  const failed = subscribeThread(transport, "failed-thread", "10");
  try {
    const deadline = Date.now() + 2000;
    expect((await healthy.next(deadline)).type).toBe("live");
    await wire.until(() => attempts === 1);
    wire.publish(frames.started("healthy"));
    expect(await healthy.next(deadline)).toMatchObject({ type: "event", event: { seq: "1" } });
    expect((await failed.next(deadline)).type).toBe("live");
    wire.publish(frames.finished("healthy"));
    expect(await healthy.next(deadline)).toMatchObject({ type: "event", event: { seq: "2" } });
    expect(attempts).toBe(2);
    expect(wire.connections).toBe(1);
    expect(
      wire.clientMessages.filter((m) => m.type === "subscribe" && m.threadId === THREAD_ID),
    ).toHaveLength(1);
    expect(
      wire.clientMessages
        .filter((m) => m.type === "subscribe" && m.threadId === "failed-thread")
        .map((m) => m.lastSeq),
    ).toEqual(["10", "10"]);
  } finally {
    healthy.unsubscribe();
    failed.unsubscribe();
    transport.disconnect();
  }
});
