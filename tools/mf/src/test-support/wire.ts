/**
 * A thin HTTP and WebSocket harness for ./mf command tests. It decides nothing about the chat.
 * A test states the contract facts it needs (what admission answers, which snapshot each read
 * gets, what Stop answers, which frames the journal holds and when), and the harness serves
 * them over a real server so the CLI, client code, serializer and socket all run. It records
 * what ./mf posted and can break a transport after the fact. Server policy (Stop's scope,
 * adoption, settlement) is proven in the server's own protocol tests and real-stack probes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type AdmissionLookup,
  type AGUIEvent,
  type CancelTurnResponse,
  type DocumentAddressResult,
  type SendMessageRequest,
  type SendMessageResponse,
  type SequencedEvent,
  serializeTransport,
  type ThreadSnapshotResponse,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type {
  HandBackRequest,
  HandBackResponse,
  SendNowRequest,
  SendNowResponse,
  StopRequest,
  StopResponse,
} from "@meridian/contracts/threads";
import { type WebSocket, WebSocketServer } from "ws";
import { runCli } from "../main";
import {
  COOKIE,
  DOCUMENT_ID,
  PROJECT_ID,
  recordOf,
  snapshotOf,
  THREAD_ID,
  thread,
} from "./wire-fixtures";

/** How one answer fails. With no `status`, `body`, `text` or `drop`, the normal answer follows the delay. */
export type Reply = {
  status?: number;
  body?: unknown;
  /** A raw body that is not JSON. */
  text?: string;
  /** Destroy the connection without answering. */
  drop?: true;
  delayMs?: number;
};

export type RouteKind =
  | "admit"
  | "lookup"
  | "snapshot"
  | "stop"
  | "handBack"
  | "sendNow"
  | "cancel"
  | "mock"
  | "other";
type Recorded = { kind: RouteKind; method: string; path: string; body: unknown };
type Cursor = { threadId: string; lastSeq: string };

export class Wire {
  /** What the next snapshot read returns; a function sees the 1-based read number. */
  snapshot: ThreadSnapshotResponse | ((read: number) => ThreadSnapshotResponse) = snapshotOf();
  admit: (body: SendMessageRequest) => SendMessageResponse = () => ({
    threadId: THREAD_ID,
    userTurnId: "u1",
    runStateVersion: null,
    resumeAfterSeq: String(this.journal.length),
    snapshotFloorNextSeq: String(this.journal.length),
    status: "accepted",
  });
  lookup: (submissionId: string) => AdmissionLookup = (submissionId) => ({
    kind: "not-seen",
    submissionId,
  });
  stop: (body: StopRequest) => StopResponse = () => ({
    threadId: THREAD_ID,
    handedBack: [],
    answered: [],
    gone: [],
    cancelledExecutionId: null,
    runState: recordOf(),
  });
  handBack: (body: HandBackRequest) => HandBackResponse = () => ({
    handedBack: [],
    answered: [],
    gone: [],
    runState: recordOf(),
  });
  sendNow: (body: SendNowRequest) => SendNowResponse = () => ({
    threadId: THREAD_ID,
    cancelledExecutionId: null,
    runState: recordOf(),
  });
  cancel: (turnId: string) => CancelTurnResponse = (turnId) => ({
    threadId: THREAD_ID,
    turnId,
    status: "not_found",
  });
  /** Sees every client frame on the socket, to publish or answer as the scenario says. */
  onClient?: (message: Record<string, unknown>, ws: WebSocket) => void;
  /** Overrides the answer to one subscription cursor: a frame to send instead, or a close code. */
  onSubscribe?: (cursor: Cursor) => WsServerMessage | { close: number } | undefined;

  readonly journal: SequencedEvent[] = [];
  readonly requests: Recorded[] = [];
  readonly clientMessages: Record<string, unknown>[] = [];
  /** Sockets ever accepted, and subscription cursors ever answered. */
  connections = 0;
  subscriptions = 0;
  reads = 0;
  baseUrl = "";

  private readonly server: Server;
  private readonly sockets = new Set<WebSocket>();
  private readonly faults = new Map<RouteKind, { reply: Reply; times: number }[]>();
  private readonly scripts: Promise<unknown>[] = [];
  private scriptError: unknown;
  private mockScripts = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    const wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(req, ws)),
    );
  }

  async listen() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  get head() {
    return this.journal.length;
  }

  requestsOf(kind: RouteKind) {
    return this.requests.filter((request) => request.kind === kind);
  }

  bodiesOf(kind: RouteKind) {
    return this.requestsOf(kind).map((request) => request.body);
  }

  /** Appends one frame to the journal and sends it to every open socket. */
  publish(event: AGUIEvent) {
    const seq = String(this.journal.length + 1);
    this.journal.push({ seq, event });
    this.broadcast({ type: "event", threadId: THREAD_ID, seq, event });
  }

  /** Replaces a route's next `times` answers with a transport failure; the route's handler still runs. */
  fail(kind: RouteKind, reply: Reply, times = 1) {
    this.faults.set(kind, [...(this.faults.get(kind) ?? []), { reply, times }]);
  }

  dropSockets(code = 1012) {
    for (const socket of this.sockets) socket.close(code, "scripted");
  }

  /** Runs an async scenario step alongside the CLI; `close` rethrows its failure. */
  play(script: () => Promise<void> | void) {
    this.scripts.push(
      Promise.resolve()
        .then(script)
        .catch((error) => {
          this.scriptError ??= error;
        }),
    );
  }

  async until(predicate: () => boolean, ms = 5000) {
    const stopAt = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > stopAt) throw new Error("wire: condition not reached");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async mf(argv: string[], env: Record<string, string> = {}) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, {
      io: {
        stdout: { write: (chunk: string) => (stdout += chunk) },
        stderr: { write: (chunk: string) => (stderr += chunk) },
      },
      env: { MF_SERVER_URL: this.baseUrl, MF_COOKIE: COOKIE, ...env },
      repoRoot: process.cwd(),
    });
    return { code, stdout, stderr };
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled(this.scripts);
    if (this.scriptError) throw this.scriptError;
  }

  /** What the next snapshot read would show, without counting a read. */
  private peek() {
    return typeof this.snapshot === "function" ? this.snapshot(this.reads + 1) : this.snapshot;
  }

  private broadcast(frame: WsServerMessage) {
    for (const socket of this.sockets)
      if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  }

  private accept(req: IncomingMessage, ws: WebSocket) {
    if (req.headers.cookie !== COOKIE) return void ws.close(4401, "auth_failed");
    this.connections += 1;
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    const send = (frame: WsServerMessage) => ws.send(JSON.stringify(frame));
    send({
      type: "connected",
      connectionToken: "wire",
      userId: "u1",
      scope: { type: "standalone" },
      serverVersion: "wire",
    });
    send({ type: "ping", ts: Date.now() });
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown> & {
        type: string;
        lastSeq?: string;
        subscriptions?: Cursor[];
      };
      this.clientMessages.push(message);
      this.onClient?.(message, ws);
      const cursors =
        message.type === "resume"
          ? (message.subscriptions ?? [])
          : message.type === "subscribe"
            ? [{ threadId: THREAD_ID, lastSeq: message.lastSeq ?? "0" }]
            : [];
      for (const cursor of cursors) {
        const override = this.onSubscribe?.(cursor);
        if (override && "close" in override) return void ws.close(override.close, "scripted");
        this.subscriptions += 1;
        if (override) {
          send(override);
          continue;
        }
        send({
          type: "subscribed",
          threadId: cursor.threadId,
          catchup: this.journal.filter((entry) => BigInt(entry.seq) > BigInt(cursor.lastSeq)),
          state: this.peek().liveState,
        });
      }
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://wire");
    const path = url.pathname;
    const body = await readBody(req);
    const kind = classify(req.method ?? "GET", path);
    this.requests.push({ kind, method: req.method ?? "GET", path: path + url.search, body });
    const reply = async (status: number, payload: unknown, enveloped = false) => {
      const fault = this.nextFault(kind);
      if (fault?.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
      if (fault?.drop) return void req.socket.destroy();
      if (fault?.text !== undefined) {
        res.writeHead(fault.status ?? 200, { "content-type": "application/json" });
        return void res.end(fault.text);
      }
      const answered = fault?.status !== undefined || fault?.body !== undefined;
      res.writeHead(answered ? (fault.status ?? 200) : status, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(
          answered ? (fault.body ?? {}) : enveloped ? serializeTransport(payload) : payload,
        ),
      );
    };
    if (req.headers.cookie !== COOKIE) return reply(401, { message: "unauthenticated" });
    const route = `${req.method} ${path}`;
    switch (kind) {
      case "lookup":
        return reply(200, this.lookup(path.split("/").at(-1) ?? ""));
      case "admit":
        return reply(202, this.admit(body as SendMessageRequest));
      case "snapshot": {
        this.reads += 1;
        const snapshot =
          typeof this.snapshot === "function" ? this.snapshot(this.reads) : this.snapshot;
        return reply(200, snapshot, true);
      }
      case "stop":
        return reply(200, this.stop(body as StopRequest), true);
      case "handBack":
        return reply(200, this.handBack(body as HandBackRequest), true);
      case "sendNow":
        return reply(200, this.sendNow(body as SendNowRequest), true);
      case "cancel":
        return reply(200, this.cancel(path.split("/").at(-2) ?? ""));
      case "mock":
        if (req.method === "POST") {
          this.mockScripts += 1;
          return reply(200, { id: `script-${this.mockScripts}`, scripts: [] });
        }
        return reply(200, { scripts: [] });
    }
    return reply(...staticRoute(route, path));
  }

  private nextFault(kind: RouteKind) {
    const queue = this.faults.get(kind);
    const fault = queue?.[0];
    if (!fault) return undefined;
    if (--fault.times <= 0) queue?.shift();
    return fault.reply;
  }
}

export async function startWire(): Promise<Wire> {
  const wire = new Wire();
  await wire.listen();
  return wire;
}

function classify(method: string, path: string): RouteKind {
  if (method === "GET" && path.includes("/admissions/")) return "lookup";
  if (method === "POST" && path === `/api/threads/${THREAD_ID}/messages`) return "admit";
  if (method === "GET" && path === `/api/threads/${THREAD_ID}/snapshot`) return "snapshot";
  if (method === "POST" && path === `/api/threads/${THREAD_ID}/stop`) return "stop";
  if (method === "POST" && path === `/api/threads/${THREAD_ID}/hand-back`) return "handBack";
  if (method === "POST" && path === `/api/threads/${THREAD_ID}/send-now`) return "sendNow";
  if (method === "POST" && /^\/api\/threads\/[^/]+\/turns\/[^/]+\/cancel$/.test(path))
    return "cancel";
  if (path === "/api/debug/mock-model/script") return "mock";
  return "other";
}

/** Routes whose answer is the same fixed fact in every scenario. */
function staticRoute(route: string, path: string): [number, unknown, boolean?] {
  if (route === "GET /api/threads") return [200, { threads: [thread()] }, true];
  if (route === "POST /api/projects/bootstrap-default") return [201, { projectId: PROJECT_ID }];
  if (route === "POST /api/threads") return [201, thread(), true];
  if (route === `GET /api/threads/${THREAD_ID}/skills`)
    return [200, { skills: [{ slug: "revise", name: "Revise", description: "Revise prose" }] }];
  if (route === "GET /api/big") return [200, { blob: "x".repeat(300_000) }];
  if (route === "GET /api/agents")
    return [
      200,
      {
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
      },
      true,
    ];
  if (route === `GET /api/projects/${PROJECT_ID}/context/kb/address`)
    return [
      200,
      {
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
      } satisfies DocumentAddressResult,
      true,
    ];
  const byRef = path.match(/^\/api\/projects\/([^/]+)\/threads\/by-ref\/([^/]+)$/);
  if (byRef)
    return byRef[1] === PROJECT_ID && byRef[2] === "c1"
      ? [200, thread(), true]
      : [404, { message: "No live thread" }];
  return [404, { message: `no route ${route}` }];
}

function readBody(req: IncomingMessage) {
  return new Promise<unknown>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : undefined);
    });
  });
}
