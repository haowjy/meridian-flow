/** In-process fake of the app API + thread socket, speaking the real contracts, for ./mf command tests. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  type AGUIEvent,
  type DocumentAddressResult,
  serializeTransport,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { Thread } from "@meridian/contracts/threads";
import { type WebSocket, WebSocketServer } from "ws";
import { runCli } from "../main";

export const COOKIE = "wos-session=test";
export const THREAD_ID = "11111111-1111-4111-8111-111111111111";
export const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
/** Longer than the text-mode diff clip, so `--full` is observable. */
export const DIVERGED_STORED_TEXT = `Stored answer ${"x".repeat(200)}`;
export const CHILD_ID = "33333333-3333-4333-8333-333333333333";

type Journal = { seq: string; event: AGUIEvent }[];

type FakeTurn = {
  id: string;
  role: "user" | "assistant";
  status: string;
  error: string | null;
  text: string;
  prevTurnId?: string;
  /** Extra persisted blocks ahead of the text block, with their own createdAt. */
  blocks?: { blockType: string; content: unknown; createdAt: string }[];
};

function threadDto(): Thread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    workId: null,
    userId: "u1",
    kind: "primary",
    status: "idle",
    title: "Fake thread",
    ref: "c1",
    initialPromptBakeId: null,
    agentDefinitionRevisionId: null,
    agentName: "General",
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: THREAD_ID,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
  };
}

function turnDto(turn: FakeTurn) {
  return {
    id: turn.id,
    threadId: THREAD_ID,
    ...(turn.prevTurnId ? { prevTurnId: turn.prevTurnId } : {}),
    role: turn.role,
    origin: turn.role === "user" ? "writer" : "assistant",
    writeMode: null,
    status: turn.status,
    finishReason: null,
    inputTokens: 1,
    outputTokens: 2,
    totalCostUsd: "0",
    responseCount: 1,
    usage: null,
    error: turn.error,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    blocks: [
      ...(turn.blocks ?? []),
      ...(turn.text
        ? [
            {
              blockType: "text",
              content: turn.text,
              // The server's projection stores the prose beside the content.
              textContent: turn.text,
              createdAt: "2026-01-01T00:00:03.000Z",
            },
          ]
        : []),
    ].map((block, sequence) => ({
      id: `${turn.id}-b${sequence}`,
      turnId: turn.id,
      responseId: null,
      sequence,
      ...block,
    })),
    siblingIds: [],
    responses: [],
  };
}

function liveState(seq: string, pendingItems: unknown[] = []) {
  return {
    threadId: THREAD_ID,
    status: { kind: "asleep" },
    runningTurnId: null,
    activity: { children: [] },
    pending: { items: pendingItems },
    resumeAfterSeq: seq,
  };
}

function childNode(status: unknown, spawnStatus: string, currentTool: unknown) {
  return {
    threadId: CHILD_ID,
    parentThreadId: THREAD_ID,
    rootThreadId: THREAD_ID,
    depth: 1,
    ref: "p2",
    title: "Research",
    agentName: "Researcher",
    spawnStatus,
    status,
    originTurnId: null,
    currentTool,
  };
}

function createFake() {
  const journal: Journal = [];
  const turns: FakeTurn[] = [];
  const pendingItems: {
    id: string;
    seq: number;
    intent: "message";
    provenance: { kind: "writer"; actorId: string };
    deliveryState: "waiting";
    summary: string;
    enqueuedAt: string;
  }[] = [];
  const sockets = new Set<WebSocket>();
  const subscribedSockets = new Set<WebSocket>();
  let subscribedSocketDrops = 0;
  let socketCount = 0;
  let snapshotReads = 0;
  const mockScripts: unknown[] = [];
  const removedMockScripts: string[] = [];
  const messageBodies: unknown[] = [];
  const resumeCursors: string[] = [];
  const socketPolicy = { replayFloor: "0", closeCode: null as number | null };
  const admissionPolicy = {
    loseAnswer: false,
    lookup: "accepted" as "accepted" | "rejected" | "not-seen" | "pending" | "failed",
  };
  const interruptPolicy = {
    response: "resolved" as "resolved" | "unconfirmed" | "rejected" | "other",
  };
  const snapshotPolicy = { running: true, awake: false, releaseDelayMs: 0, delayMs: 0 };
  const replyPolicy = { holdUntilSubscribed: false };
  const heldReplies: (() => void)[] = [];
  const afterSnapshot: (() => void)[] = [];
  let leaseReleasePending = false;
  const admissions = new Map<string, unknown>();
  let runCounter = 0;
  const nextSeq = () => String(journal.length + 1);

  const publish = (event: AGUIEvent) => {
    const seq = nextSeq();
    journal.push({ seq, event });
    const frame: WsServerMessage = { type: "event", threadId: THREAD_ID, seq, event };
    for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  };

  const currentLiveState = () => {
    const runningTurnId = !snapshotPolicy.running
      ? null
      : (turns
          .slice()
          .reverse()
          .find((turn) => ["streaming", "waiting_interrupt"].includes(turn.status))?.id ?? null);
    return {
      ...liveState(String(journal.length), pendingItems),
      runningTurnId,
      status:
        runningTurnId || leaseReleasePending || snapshotPolicy.awake
          ? { kind: "awake", phase: "generating", cancelRequested: false }
          : { kind: "asleep" },
    };
  };

  const scheduleReply = (
    reply: () => void,
    delayMs: number,
    hold = replyPolicy.holdUntilSubscribed,
  ) => {
    if (hold) heldReplies.push(reply);
    else setTimeout(reply, delayMs);
  };

  const runScenario = (text: string) => {
    runCounter += 1;
    const runId = `turn-a${runCounter}`;
    turns.push({ id: `turn-u${runCounter}`, role: "user", status: "complete", error: null, text });
    const assistant: FakeTurn = {
      id: runId,
      role: "assistant",
      status: "streaming",
      error: null,
      text: "",
    };
    turns.push(assistant);
    const reply = () => {
      publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId } as AGUIEvent);
      if (text.includes("reconnect")) {
        for (const socket of sockets) {
          if (socket.readyState === 1 && subscribedSockets.has(socket)) subscribedSocketDrops += 1;
          socket.close(1012, "restart");
        }
      }
      if (text.includes("fail")) {
        assistant.status = "error";
        assistant.error = "boom";
        publish({ type: "RUN_ERROR", message: "boom" } as AGUIEvent);
        return;
      }
      if (text.includes("ask")) {
        assistant.status = "waiting_interrupt";
        publish({
          type: "CUSTOM",
          name: "meridian.interrupt",
          value: { turnId: runId, interruptId: "int-1", blockSequence: 0, state: "created" },
        } as AGUIEvent);
        return;
      }
      if (text.includes("cancelled")) {
        assistant.status = "cancelled";
        publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId } as AGUIEvent);
        return;
      }
      if (text.includes("hang")) return;
      if (text.includes("write tool")) {
        publish({
          type: "TOOL_CALL_START",
          toolCallId: "write-1",
          toolCallName: "doc_write",
        } as AGUIEvent);
        publish({ type: "TOOL_CALL_ARGS", toolCallId: "write-1", delta: "{}" } as AGUIEvent);
        publish({ type: "TOOL_CALL_END", toolCallId: "write-1" } as AGUIEvent);
        publish({
          type: "TOOL_CALL_RESULT",
          toolCallId: "write-1",
          messageId: "write-result",
          content: "staged",
        } as AGUIEvent);
        publish({
          type: "TOOL_CALL_RESULT",
          toolCallId: "write-1",
          messageId: "write-result",
          content: "committed",
        } as AGUIEvent);
      }
      if (text.includes("delegate")) {
        const activity = (value: unknown) =>
          publish({ type: "CUSTOM", name: "meridian.subagent.activity", value } as AGUIEvent);
        publish({
          type: "TOOL_CALL_START",
          toolCallId: "call-1",
          toolCallName: "spawn",
        } as AGUIEvent);
        publish({
          type: "TOOL_CALL_ARGS",
          toolCallId: "call-1",
          delta: '{"agent":"r"}',
        } as AGUIEvent);
        publish({ type: "TOOL_CALL_END", toolCallId: "call-1" } as AGUIEvent);
        activity({ children: [] });
        activity({
          children: [
            childNode({ kind: "awake", phase: "generating", cancelRequested: false }, "running", {
              toolCallId: "c-1",
              toolName: "doc_read",
              input: { uri: "manuscript://ch1.md" },
            }),
          ],
        });
        activity({ children: [childNode({ kind: "asleep" }, "succeeded", null)] });
        publish({
          type: "TOOL_CALL_RESULT",
          messageId: "call-1-result",
          toolCallId: "call-1",
          content: "p2 done",
        } as AGUIEvent);
        assistant.blocks = [
          {
            blockType: "tool_use",
            content: { toolCallId: "call-1", toolName: "spawn", input: { agent: "r" } },
            createdAt: "2026-01-01T00:00:00.500Z",
          },
          {
            blockType: "tool_result",
            content: { toolCallId: "call-1", output: "p2 done" },
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        ];
      }
      const messageId = `${runId}::0`;
      publish({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as AGUIEvent);
      publish({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "Hello" } as AGUIEvent);
      publish({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: " there" } as AGUIEvent);
      publish({ type: "TEXT_MESSAGE_END", messageId } as AGUIEvent);
      assistant.status = "complete";
      // "diverge" stores other text than the events streamed: a live view that disagrees.
      assistant.text = text.includes("diverge") ? DIVERGED_STORED_TEXT : "Hello there";
      if (snapshotPolicy.releaseDelayMs) {
        leaseReleasePending = true;
        setTimeout(() => {
          leaseReleasePending = false;
          publish({
            type: "CUSTOM",
            name: "meridian.thread.status",
            value: { status: { kind: "asleep" }, runningTurnId: null },
          } as AGUIEvent);
        }, snapshotPolicy.releaseDelayMs);
      }
      publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId } as AGUIEvent);
    };
    scheduleReply(reply, 10, replyPolicy.holdUntilSubscribed || text.includes("reconnect"));
    return runId;
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : undefined);
      });
    });

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Mirrors the real routes that answer through serializeTransport.
    const sendEnveloped = (status: number, body: unknown) => send(status, serializeTransport(body));
    if (req.headers.cookie !== COOKIE) return send(401, { message: "unauthenticated" });
    const url = new URL(req.url ?? "/", "http://fake");
    const route = `${req.method} ${url.pathname}`;
    if (req.method === "GET" && url.pathname.includes("/admissions/")) {
      const submissionId = url.pathname.split("/").at(-1) ?? "";
      if (admissionPolicy.lookup === "failed") return send(503, { message: "lookup down" });
      return send(
        200,
        admissionPolicy.lookup === "accepted"
          ? admissions.get(submissionId)
          : { kind: admissionPolicy.lookup, submissionId, code: "refused" },
      );
    }
    if (route === "GET /api/threads") return sendEnveloped(200, { threads: [threadDto()] });
    if (route === "POST /api/projects/bootstrap-default")
      return send(201, { projectId: PROJECT_ID });
    if (route === `GET /api/projects/${PROJECT_ID}/context/kb/address`) {
      return sendEnveloped(200, {
        kind: "current",
        document: {
          kind: "available",
          documentId: DOCUMENT_ID as never,
          generation: 1 as never,
          authority: { kind: "project", projectId: PROJECT_ID as never },
          entry: {
            kind: "file",
            entryId: DOCUMENT_ID as never,
            observationVersion: "1",
            scope: { kind: "project", projectId: PROJECT_ID as never },
            sourceId: "source" as never,
            parentId: "source" as never,
            name: "Cover",
            aliases: [],
            path: ["cover.png"],
            uri: "kb://cover.png" as never,
            provisionalName: false,
            editable: false,
            disposition: "binary",
            fileType: "image",
            mimeType: "image/png",
          },
        },
      } satisfies DocumentAddressResult);
    }
    if (route === `GET /api/threads/${THREAD_ID}/skills`)
      return send(200, {
        skills: [{ slug: "revise", name: "Revise", description: "Revise prose" }],
      });
    if (route === "GET /api/agents") {
      return sendEnveloped(200, {
        agents: [
          {
            slug: "general",
            name: "General",
            description: "",
            model: null,
            ownership: "system",
            unavailableReasons: [],
            selection: { catalogEntryId: "c", definitionRevisionId: "r" },
          },
        ],
        nextCursor: null,
      });
    }
    const byRef = url.pathname.match(/^\/api\/projects\/([^/]+)\/threads\/by-ref\/([^/]+)$/);
    if (req.method === "GET" && byRef) {
      return byRef[1] === PROJECT_ID && byRef[2] === "c1"
        ? sendEnveloped(200, threadDto())
        : send(404, { message: "No live thread" });
    }
    if (route === "POST /api/threads") {
      const body = (await readBody(req)) as { agentSelection?: unknown };
      if (!body?.agentSelection) return send(400, { message: "agentSelection required" });
      return sendEnveloped(201, threadDto());
    }
    if (route === `POST /api/threads/${THREAD_ID}/messages`) {
      const body = (await readBody(req)) as {
        submissionId: string;
        text: string;
        blocks: { text?: string }[];
      };
      messageBodies.push(body);
      const concatenated = body.blocks.map((block) => block.text ?? "").join("");
      if (concatenated !== body.text) return send(400, { message: "text must equal blocks" });
      const resumeAfterSeq = String(journal.length);
      if (body.text === "steer behind completed run") {
        runCounter += 1;
        const userTurnId = `turn-u${runCounter}`;
        const first: FakeTurn = {
          id: "reply-first",
          role: "assistant",
          status: "streaming",
          error: null,
          text: "",
        };
        const second: FakeTurn = {
          id: "reply-second",
          role: "assistant",
          prevTurnId: userTurnId,
          status: "pending",
          error: null,
          text: "",
        };
        turns.push(
          first,
          { id: userTurnId, role: "user", status: "complete", error: null, text: body.text },
          second,
        );
        pendingItems.push({
          id: userTurnId,
          seq: runCounter,
          intent: "message",
          provenance: { kind: "writer", actorId: "u1" },
          deliveryState: "waiting",
          summary: body.text,
          enqueuedAt: "2026-01-02T00:00:00.000Z",
        });
        scheduleReply(() => {
          first.status = "complete";
          first.text = "First answer";
          second.status = "streaming";
          publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: first.id } as AGUIEvent);
          publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId: second.id } as AGUIEvent);
          const finishSecond = () => {
            second.status = "complete";
            second.text = "Second answer";
            pendingItems.splice(0);
            publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: second.id } as AGUIEvent);
          };
          // Confirm the owed successor before settling it; no timer may erase that state.
          if (replyPolicy.holdUntilSubscribed) afterSnapshot.push(finishSecond);
          else setTimeout(finishSecond, 100);
        }, 50);
        return send(202, {
          threadId: THREAD_ID,
          userTurnId,
          assistantTurnId: first.id,
          resumeAfterSeq,
          snapshotFloorNextSeq: resumeAfterSeq,
          status: "accepted",
        });
      }
      if (body.text === "wait behind cancelled run") {
        runCounter += 1;
        const userTurnId = `turn-u${runCounter}`;
        const runningTurnId = `turn-running-${runCounter}`;
        const running: FakeTurn = {
          id: runningTurnId,
          role: "assistant",
          status: "streaming",
          error: null,
          text: "",
        };
        turns.push(running);
        turns.push({
          id: userTurnId,
          role: "user",
          prevTurnId: runningTurnId,
          status: "complete",
          error: null,
          text: body.text,
        });
        pendingItems.push({
          id: userTurnId,
          seq: runCounter,
          intent: "message",
          provenance: { kind: "writer", actorId: "u1" },
          deliveryState: "waiting",
          summary: body.text,
          enqueuedAt: "2026-01-02T00:00:00.000Z",
        });
        scheduleReply(() => {
          running.status = "error";
          running.error = "cancelled";
          pendingItems.splice(0, pendingItems.length);
          const replyId = `turn-reply-${runCounter}`;
          const reply: FakeTurn = {
            id: replyId,
            role: "assistant",
            prevTurnId: userTurnId,
            status: "streaming",
            error: null,
            text: "",
          };
          turns.push(reply);
          publish({ type: "RUN_ERROR", message: "cancelled" } as AGUIEvent);
          setTimeout(() => {
            publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId: replyId } as AGUIEvent);
            const messageId = `${replyId}::0`;
            publish({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as AGUIEvent);
            publish({
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta: "Answered the queued message",
            } as AGUIEvent);
            publish({ type: "TEXT_MESSAGE_END", messageId } as AGUIEvent);
            reply.status = "complete";
            reply.text = "Answered the queued message";
            publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: replyId } as AGUIEvent);
          }, 20);
        }, 5);
        return send(202, {
          threadId: THREAD_ID,
          userTurnId,
          assistantTurnId: runningTurnId,
          resumeAfterSeq,
          snapshotFloorNextSeq: resumeAfterSeq,
          status: "accepted",
        });
      }
      runScenario(body.text);
      const accepted = {
        threadId: THREAD_ID,
        submissionId: body.submissionId,
        userTurnId: `turn-u${runCounter}`,
        assistantTurnId: null,
        resumeAfterSeq,
        snapshotFloorNextSeq: resumeAfterSeq,
        status: "accepted",
      };
      admissions.set(body.submissionId, { ...accepted, kind: "accepted" });
      if (admissionPolicy.loseAnswer) {
        req.socket.destroy();
        return;
      }
      return send(202, accepted);
    }
    if (route === `GET /api/threads/${THREAD_ID}/snapshot`) {
      snapshotReads += 1;
      if (snapshotPolicy.delayMs)
        await new Promise((resolve) => setTimeout(resolve, snapshotPolicy.delayMs));
      sendEnveloped(200, {
        threadId: THREAD_ID,
        thread: threadDto(),
        turns: turns.map(turnDto),
        liveState: currentLiveState(),
        actionRequired: false,
        nextSeq: String(journal.length + 1),
      });
      for (const reply of afterSnapshot.splice(0)) reply();
      return;
    }
    const cancel = url.pathname.match(/^\/api\/threads\/[^/]+\/turns\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancel) {
      const turn = turns.find((candidate) => candidate.id === cancel[1]);
      const status = !turn
        ? "not_found"
        : ["complete", "error", "cancelled"].includes(turn.status)
          ? "already_finished"
          : "cancelled";
      if (turn && status === "cancelled") turn.status = "cancelled";
      return send(200, { threadId: THREAD_ID, turnId: cancel[1], status });
    }
    if (route === "POST /api/debug/mock-model/script") {
      mockScripts.push(await readBody(req));
      return send(200, { id: `script-${mockScripts.length}`, scripts: [] });
    }
    if (route === "DELETE /api/debug/mock-model/script") {
      removedMockScripts.push(url.searchParams.get("id") ?? "*");
      return send(200, { scripts: [] });
    }
    if (route === "GET /api/big") return send(200, { blob: "x".repeat(300_000) });
    return send(404, { message: `no route ${route}` });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (req.headers.cookie !== COOKIE) {
        ws.close(4401, "auth_failed");
        return;
      }
      socketCount += 1;
      sockets.add(ws);
      ws.on("close", () => {
        sockets.delete(ws);
        subscribedSockets.delete(ws);
      });
      ws.send(
        JSON.stringify({
          type: "connected",
          connectionToken: "fake-connection",
          userId: "u1",
          scope: { type: "standalone" },
          serverVersion: "fake",
        } satisfies WsServerMessage),
      );
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() } satisfies WsServerMessage));
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as {
          type: string;
          lastSeq?: string;
          subscriptions?: { threadId: string; lastSeq: string }[];
          interruptId?: string;
          turnId?: string;
        };
        if (message.type === "interrupt.respond") {
          if (interruptPolicy.response === "rejected")
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
          else if (interruptPolicy.response !== "unconfirmed")
            publish({
              type: "CUSTOM",
              name: "meridian.interrupt",
              value: {
                turnId: message.turnId,
                interruptId:
                  interruptPolicy.response === "other" ? "other-id" : message.interruptId,
                state: "resolved",
              },
            } as AGUIEvent);
        }
        const cursors =
          message.type === "resume"
            ? (message.subscriptions ?? [])
            : message.type === "subscribe"
              ? [{ threadId: THREAD_ID, lastSeq: message.lastSeq ?? "0" }]
              : [];
        for (const cursor of cursors) {
          if (socketPolicy.closeCode !== null) {
            ws.close(socketPolicy.closeCode, "fake rejection");
            return;
          }
          if (BigInt(cursor.lastSeq) < BigInt(socketPolicy.replayFloor)) {
            ws.send(
              JSON.stringify({
                type: "gap",
                threadId: cursor.threadId,
                cause: "replay_limit_exceeded",
                fromSeq: cursor.lastSeq,
                toSeq: socketPolicy.replayFloor,
              } satisfies WsServerMessage),
            );
            continue;
          }
          if (message.type === "resume") resumeCursors.push(cursor.lastSeq);
          const after = BigInt(cursor.lastSeq);
          const frame: WsServerMessage = {
            type: "subscribed",
            threadId: cursor.threadId,
            catchup: journal.filter((entry) => BigInt(entry.seq) > after),
            state: currentLiveState() as never,
          };
          ws.send(JSON.stringify(frame));
          subscribedSockets.add(ws);
          // The follower receives its subscribed state before held replies settle.
          for (const reply of heldReplies.splice(0)) reply();
        }
      });
    });
  });

  return {
    server,
    mockScripts,
    removedMockScripts,
    messageBodies,
    resumeCursors,
    socketPolicy,
    admissionPolicy,
    interruptPolicy,
    snapshotPolicy,
    replyPolicy,
    turns,
    publish,
    socketCount: () => socketCount,
    subscribedSocketDrops: () => subscribedSocketDrops,
    snapshotReads: () => snapshotReads,
  };
}

export type FakeStack = ReturnType<typeof createFake> & {
  baseUrl: string;
  mf(
    argv: string[],
    env?: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
};

/** Starts the fake on an ephemeral port; `mf` runs the CLI against it with a valid session cookie. */
export async function startFakeStack(): Promise<FakeStack> {
  const fake = createFake();
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const address = fake.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    ...fake,
    baseUrl,
    async mf(argv, env = {}) {
      let stdout = "";
      let stderr = "";
      const code = await runCli(argv, {
        io: {
          stdout: { write: (chunk: string) => (stdout += chunk) },
          stderr: { write: (chunk: string) => (stderr += chunk) },
        },
        env: { MF_SERVER_URL: baseUrl, MF_COOKIE: COOKIE, ...env },
        repoRoot: process.cwd(),
      });
      return { code, stdout, stderr };
    },
    async close() {
      fake.server.closeAllConnections();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    },
  };
}
