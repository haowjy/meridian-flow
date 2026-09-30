/** In-process fake of the app API + thread socket, speaking the real contracts, for ./mf command tests. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  type AGUIEvent,
  serializeTransport,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { Thread } from "@meridian/contracts/threads";
import { type WebSocket, WebSocketServer } from "ws";
import { runCli } from "../main";

export const COOKIE = "wos-session=test";
export const THREAD_ID = "11111111-1111-4111-8111-111111111111";
export const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
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
        ? [{ blockType: "text", content: turn.text, createdAt: "2026-01-01T00:00:03.000Z" }]
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
  const mockScripts: unknown[] = [];
  const removedMockScripts: string[] = [];
  let runCounter = 0;
  const nextSeq = () => String(journal.length + 1);

  const publish = (event: AGUIEvent) => {
    const seq = nextSeq();
    journal.push({ seq, event });
    const frame: WsServerMessage = { type: "event", threadId: THREAD_ID, seq, event };
    for (const socket of sockets) socket.send(JSON.stringify(frame));
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
    setTimeout(() => {
      publish({ type: "RUN_STARTED", threadId: THREAD_ID, runId } as AGUIEvent);
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
      if (text.includes("hang")) return;
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
      assistant.text = "Hello there";
      publish({ type: "RUN_FINISHED", threadId: THREAD_ID, runId } as AGUIEvent);
    }, 10);
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
    if (route === "GET /api/threads") return sendEnveloped(200, { threads: [threadDto()] });
    if (route === "POST /api/projects/bootstrap-default")
      return send(201, { projectId: PROJECT_ID });
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
      const body = (await readBody(req)) as { text: string; blocks: { text?: string }[] };
      const concatenated = body.blocks.map((block) => block.text ?? "").join("");
      if (concatenated !== body.text) return send(400, { message: "text must equal blocks" });
      const resumeAfterSeq = String(journal.length);
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
        setTimeout(() => {
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
      return send(202, {
        threadId: THREAD_ID,
        userTurnId: `turn-u${runCounter}`,
        assistantTurnId: null,
        resumeAfterSeq,
        snapshotFloorNextSeq: resumeAfterSeq,
        status: "accepted",
      });
    }
    if (route === `GET /api/threads/${THREAD_ID}/snapshot`) {
      return sendEnveloped(200, {
        threadId: THREAD_ID,
        thread: threadDto(),
        turns: turns.map(turnDto),
        liveState: liveState(String(journal.length), pendingItems),
        actionRequired: false,
        nextSeq: String(journal.length + 1),
      });
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
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; lastSeq?: string };
        if (message.type !== "subscribe") return;
        const after = BigInt(message.lastSeq ?? "0");
        const frame: WsServerMessage = {
          type: "subscribed",
          threadId: THREAD_ID,
          catchup: journal.filter((entry) => BigInt(entry.seq) > after),
          state: liveState(String(journal.length), pendingItems) as never,
        };
        ws.send(JSON.stringify(frame));
      });
    });
  });

  return { server, mockScripts, removedMockScripts };
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
