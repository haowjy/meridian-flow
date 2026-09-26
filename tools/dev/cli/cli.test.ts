/**
 * End-to-end `./mf` contract against an in-process fake of the app API + thread socket:
 * exit codes, stdout/stderr separation, --json envelopes, and the send-and-wait loop.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AGUIEvent, WsServerMessage } from "@meridian/contracts/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { EXIT } from "./cli-error";
import { composeMessage } from "./commands/thread-drive";
import { COMMANDS, runCli } from "./main";

const COOKIE = "wos-session=test";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

type Journal = { seq: string; event: AGUIEvent }[];

type FakeTurn = {
  id: string;
  role: "user" | "assistant";
  status: string;
  error: string | null;
  text: string;
};

function threadDto() {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    workId: null,
    userId: "u1",
    kind: "primary",
    status: "active",
    title: "Fake thread",
    ref: "c1",
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
    deletedAt: null,
  };
}

function turnDto(turn: FakeTurn) {
  return {
    id: turn.id,
    threadId: THREAD_ID,
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
    blocks: turn.text
      ? [
          {
            id: `${turn.id}-b0`,
            turnId: turn.id,
            responseId: null,
            blockType: "text",
            sequence: 0,
            content: turn.text,
          },
        ]
      : [],
    siblingIds: [],
    responses: [],
  };
}

function liveState(seq: string) {
  return {
    threadId: THREAD_ID,
    status: { kind: "asleep" },
    runningTurnId: null,
    activity: { descendants: [] },
    pending: { items: [] },
    resumeAfterSeq: seq,
  };
}

function createFake() {
  const journal: Journal = [];
  const turns: FakeTurn[] = [];
  const sockets = new Set<WebSocket>();
  const mockScripts: unknown[] = [];
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
    if (req.headers.cookie !== COOKIE) return send(401, { message: "unauthenticated" });
    const url = new URL(req.url ?? "/", "http://fake");
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/threads") return send(200, { threads: [threadDto()] });
    if (route === "POST /api/projects/bootstrap-default")
      return send(201, { projectId: PROJECT_ID });
    if (route === "GET /api/agents") {
      return send(200, {
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
    if (route === "POST /api/threads") {
      const body = (await readBody(req)) as { agentSelection?: unknown };
      if (!body?.agentSelection) return send(400, { message: "agentSelection required" });
      return send(201, threadDto());
    }
    if (route === `POST /api/threads/${THREAD_ID}/messages`) {
      const body = (await readBody(req)) as { text: string; blocks: { text?: string }[] };
      const concatenated = body.blocks.map((block) => block.text ?? "").join("");
      if (concatenated !== body.text) return send(400, { message: "text must equal blocks" });
      const resumeAfterSeq = String(journal.length);
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
      return send(200, {
        threadId: THREAD_ID,
        thread: threadDto(),
        turns: turns.map(turnDto),
        liveState: liveState(String(journal.length)),
        actionRequired: false,
        nextSeq: String(journal.length + 1),
      });
    }
    if (route === "POST /api/debug/mock-model/script") {
      mockScripts.push(await readBody(req));
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
          state: liveState(String(journal.length)) as never,
        };
        ws.send(JSON.stringify(frame));
      });
    });
  });

  return { server, mockScripts };
}

let fake: ReturnType<typeof createFake>;
let baseUrl = "";

beforeAll(async () => {
  fake = createFake();
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const address = fake.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  fake.server.closeAllConnections();
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

async function mf(argv: string[], env: Record<string, string> = {}) {
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
}

describe("./mf", () => {
  it("lists every command with the route it wraps", async () => {
    const { code, stdout } = await mf([]);
    expect(code).toBe(EXIT.ok);
    for (const spec of COMMANDS) {
      expect(stdout).toContain(`./mf ${spec.path.join(" ")}`);
      expect(stdout).toContain(spec.route);
    }
  });

  it("rejects unknown flags and commands with exit 2", async () => {
    expect((await mf(["thread", "view", THREAD_ID, "--bogus"])).code).toBe(EXIT.usage);
    expect((await mf(["nope"])).code).toBe(EXIT.usage);
  });

  it("reports an unreachable stack as exit 4 with a JSON error on stderr", async () => {
    const result = await mf(["thread", "list", "--json"], { MF_SERVER_URL: "http://127.0.0.1:9" });
    expect(result.code).toBe(EXIT.unavailable);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "unavailable" });
  });

  it("maps 401 to exit 4", async () => {
    expect((await mf(["thread", "list"], { MF_COOKIE: "wrong" })).code).toBe(EXIT.unavailable);
  });

  it("resolves thread refs and id prefixes", async () => {
    const byRef = await mf(["thread", "view", "c1", "--json", "--fields", "thread"]);
    expect(byRef.code).toBe(EXIT.ok);
    expect(JSON.parse(byRef.stdout)).toEqual({
      thread: expect.objectContaining({ id: THREAD_ID }),
    });
    expect((await mf(["thread", "view", "1111"])).code).toBe(EXIT.ok);
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

  it("send --mock queues the script scoped to the message text first", async () => {
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

  it("thread view renders the transcript", async () => {
    const result = await mf(["thread", "view", THREAD_ID]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("[assistant]");
    expect(result.stdout).toContain("Hello there");
  });

  it("writes large JSON results whole", async () => {
    const result = await mf(["api", "GET", "/api/big", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout).blob).toHaveLength(300_000);
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
