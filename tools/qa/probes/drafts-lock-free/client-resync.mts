/**
 * Phase 4 (design §2.7, R1/D30/G1–G3): a draft tab's reconnect never produces a causal gap the
 * server must refuse. The connection's own SyncStep2 carries every byte the server lacks, held
 * keystrokes follow it, and a prefix-missing close (`4207`) is a plain reconnect.
 *
 * End to end, in one Node process: the production client transport (bundled from
 * `apps/app`, `client-resync.client.mjs`) over an in-memory socket pair to the production
 * gateway (`createYjsGateway`: Hocuspocus, `beforeSync` admission, the persistence service,
 * the coordinator and store) on the scratch database. No port, no dev stack. A "server" is one
 * gateway with its own coordinator; a restart replaces it. The server can be held at
 * `branch.append.beforeCommit` while the socket drops.
 *
 * (f) one tab typing at 50 ms, the socket dropped three times while the server holds that
 *     connection's last frame uncommitted, so every reconnect starts behind a causal gap;
 * (g) partial acknowledgement: five keys sent, three acknowledged, the socket dropped;
 * (h) a server restart mid-burst, typing on through it;
 * (i) a reload while offline: the unsent keys are gone (W42, no branch cache before PR B), the
 *     reloaded tab syncs and types;
 * (k) a raw y-protocols client sending a dependent Update before its SyncStep2: one `4207`,
 *     then its next connection's SyncStep2 lands.
 * Across (f)–(i): no `1008`, no `4207`, no terminal state, every key durable once and in order,
 * no clock journaled twice (released echoes write nothing), a receipt for every row, the outbox
 * empty after the last acknowledgement, and on every branch connection `step1, step2` before
 * any update. First-acknowledgement latency after each open is reported.
 *
 * The transport layer's own cases (four `4207` closes keep the outbox, wire order, a socket
 * closed before its SyncStep2) are lane 1c's tests in `hocuspocus-document-transport*.test.ts`.
 * (j), the live-room collision regression, needs live journal admission and offline
 * reconciliation wired; it stays with the browser recipe (docs/qa/drafts-lock-free-probes.md).
 *
 * Negative control on `586e58ae1e` (client without the hold, server without finalization):
 * every reconnect's queued updates reach the server before its SyncStep2.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import { createHocuspocusBinding } from "../../../../apps/server/server/domains/collab/adapters/hocuspocus-binding.ts";
import { createHocuspocusPersistenceService } from "../../../../apps/server/server/domains/collab/hocuspocus-persistence.ts";
import { createYjsGateway } from "../../../../apps/server/server/lib/yjs-ws-handler.ts";
import { type Harness, observe, type Probe, Y } from "./harness.mts";
import {
  deadline,
  journalRows,
  pauseAt,
  percentiles,
  phase4Coordinator,
  receipts,
  runArms,
  seedDraft,
  structsOf,
  within,
} from "./phase4.mts";

// Hocuspocus's sync codec, resolved as the server resolves it.
const serverRequire = createRequire(
  new URL("../../../../apps/server/package.json", import.meta.url),
);
const encoding = serverRequire("lib0/encoding");
const decoding = serverRequire("lib0/decoding");

const KEY_MS = 50;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Tab = {
  loaded(): boolean;
  type(token: string): void;
  text(): string;
  clientID(): number;
  unacknowledged(): Uint8Array | null;
  acknowledged(): boolean;
  states: { kind: string; reason?: string; code?: number }[];
  destroy(): void;
};

/** The client bundle: the production transport, its `@/` alias and `import.meta.env` resolved. */
async function loadClient(): Promise<{ openTab(roomName: string): Tab }> {
  const repo = new URL("../../../../", import.meta.url).pathname;
  const tsxRequire = createRequire(createRequire(import.meta.url).resolve("tsx/package.json"));
  const esbuild = tsxRequire("esbuild") as {
    build(options: Record<string, unknown>): Promise<unknown>;
  };
  const directory = mkdtempSync(join(tmpdir(), "lfd-probe-client-"));
  const outfile = join(directory, "client.mjs");
  try {
    await esbuild.build({
      entryPoints: [new URL("./client-resync.client.mjs", import.meta.url).pathname],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      alias: { "@": join(repo, "apps/app/src") },
      nodePaths: [join(repo, "apps/app/node_modules")],
      define: { "import.meta.env.DEV": "false", "import.meta.env.VITE_DEBUG_OVERLAY": '"0"' },
    });
    return (await import(pathToFileURL(outfile).href)) as { openTab(roomName: string): Tab };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Frame = { at: number; room: string; type: number; sub: number; payload: Uint8Array };

function decodeFrame(bytes: Uint8Array): Omit<Frame, "at"> | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const room = decoding.readVarString(decoder) as string;
    const type = decoding.readVarUint(decoder) as number;
    if (type !== 0) return { room, type, sub: -1, payload: new Uint8Array() };
    const sub = decoding.readVarUint(decoder) as number;
    return { room, type, sub, payload: decoding.readVarUint8Array(decoder) };
  } catch {
    return null;
  }
}

const SYNC_KIND = ["step1", "step2", "update"] as const;

/**
 * One socket: the browser `WebSocket` the transport sees on one side, a gateway peer on the
 * other. Frames are delivered a task later each way, as a network would.
 */
class PipeSocket {
  static connector: ((socket: PipeSocket) => void) | null = null;
  static readonly all: PipeSocket[] = [];
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  readonly protocols: string[];
  readonly sent: Frame[] = [];
  readonly received: Frame[] = [];
  openedAt = 0;
  closedWith: { code: number; reason: string; by: "server" | "client" | "network" } | null = null;
  /** The server side, set by the connector. */
  toServer: ((bytes: Uint8Array) => void) | null = null;
  serverClosed: ((event: { code: number; reason: string }) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = url.toString();
    this.protocols =
      protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    PipeSocket.all.push(this);
    setTimeout(() => {
      const connect = PipeSocket.connector;
      if (!connect) {
        this.finish({ code: 1006, reason: "", by: "network" });
        return;
      }
      connect(this);
      this.readyState = 1;
      this.openedAt = performance.now();
      this.dispatch("open", {});
    }, 0);
  }

  addEventListener(name: string, handler: (event: unknown) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(handler);
    this.listeners.set(name, set);
  }

  removeEventListener(name: string, handler: (event: unknown) => void) {
    this.listeners.get(name)?.delete(handler);
  }

  send(data: Uint8Array | ArrayBuffer) {
    if (this.readyState !== 1) return;
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
    const frame = decodeFrame(bytes);
    if (frame) this.sent.push({ ...frame, at: performance.now() });
    setTimeout(() => {
      if (this.readyState === 1) this.toServer?.(bytes);
    }, 0);
  }

  /** The tab closed the socket. */
  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.serverClosed?.({ code, reason });
    this.finish({ code, reason, by: "client" });
  }

  /** The network dropped the connection: both sides see 1006. */
  drop() {
    if (this.readyState >= 2) return;
    this.serverClosed?.({ code: 1006, reason: "" });
    this.finish({ code: 1006, reason: "", by: "network" });
  }

  /** The server sent a frame. */
  deliver(bytes: Uint8Array) {
    if (this.readyState !== 1) return;
    const copy = bytes.slice();
    const frame = decodeFrame(copy);
    if (frame) this.received.push({ ...frame, at: performance.now() });
    setTimeout(() => {
      if (this.readyState === 1) this.dispatch("message", { data: copy.buffer });
    }, 0);
  }

  /** The server closed the socket with `code`. */
  closeFromServer(code: number, reason: string) {
    if (this.readyState >= 2) return;
    this.serverClosed?.({ code, reason });
    this.finish({ code, reason, by: "server" });
  }

  /** The kinds of the sync frames this tab wrote on this socket, in order. */
  syncKinds(): string[] {
    return this.sent.filter((f) => f.type === 0).map((f) => SYNC_KIND[f.sub] ?? `sync${f.sub}`);
  }

  /** Time from open to the first acknowledgement (`SyncStatus`, type 8) the server sent. */
  firstAckMs(): number | null {
    const ack = this.received.find((f) => f.type === 8);
    return ack ? Math.round(ack.at - this.openedAt) : null;
  }

  private finish(closed: NonNullable<PipeSocket["closedWith"]>) {
    this.closedWith = closed;
    this.readyState = 3;
    setTimeout(
      () => this.dispatch("close", { code: closed.code, reason: closed.reason, wasClean: false }),
      0,
    );
  }

  private dispatch(name: string, event: unknown) {
    const handler = (this as unknown as Record<string, ((event: unknown) => void) | null>)[
      `on${name}`
    ];
    handler?.(event);
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

/**
 * One server process: the production gateway over its own coordinator, binding and
 * persistence service, on `harness`'s store. Access is granted to the probe's user.
 */
function openServer(harness: Harness, workId: string) {
  const binding = createHocuspocusBinding();
  const prefixMissing: unknown[] = [];
  const coordinator = phase4Coordinator(harness, {
    onBranchUpdate: (update) => binding.publishBranchUpdate(update),
    diagnostics: { appendPrefixMissing: (input) => prefixMissing.push(input) },
  });
  const persistence = createHocuspocusPersistenceService({
    branchStore: harness.store,
    branchCoordinator: coordinator,
    journal: {} as never,
    hocuspocus: () => binding.current(),
    metaForOrigin: () => ({ origin: "system", seq: 0 }) as never,
    emitAgentEditInvariantViolation: () => {},
  });
  const grant = (target: unknown) => ({
    level: "edit",
    facts: { target, ownerWork: null, draftWork: { id: workId, isNoWork: false } },
  });
  const gateway = createYjsGateway({
    liveDocuments: { findById: async () => ({ kind: "missing" }) },
    fileAccess: {
      authorize: async (_actor: unknown, target: unknown) => grant(target),
      confirmEdit: async () => [],
    },
    fileAccessChanges: { subscribe: () => () => {} },
    documentSync: {
      ...persistence,
      bindHocuspocus: binding.bind,
      flushBranchLivePull: async () => {},
    },
    eventSink: { emit() {} },
  } as never);
  const sockets = new Set<PipeSocket>();
  return {
    prefixMissing,
    /** Accepts `socket` as the Nitro WebSocket handler does. */
    accept(socket: PipeSocket) {
      sockets.add(socket);
      const peer = {
        request: new Request("https://probe.invalid/ws/yjs", {
          headers: { "sec-websocket-protocol": socket.protocols.join(", ") },
        }),
        userId: harness.ids.user,
        traceId: randomUUID(),
        socket: {
          get readyState() {
            return socket.readyState;
          },
          send: (data: Uint8Array) => socket.deliver(data),
          close: (code?: number, reason?: string) =>
            socket.closeFromServer(code ?? 1000, reason ?? ""),
        },
        close: (code?: number, reason?: string) =>
          socket.closeFromServer(code ?? 1000, reason ?? ""),
      };
      const connection = gateway.connect(peer as never);
      socket.toServer = (bytes) => gateway.message(connection, bytes);
      socket.serverClosed = (event) => {
        sockets.delete(socket);
        gateway.close(connection, event);
      };
    },
    /** A crash: every socket drops, then the process's rooms and memory are gone. */
    async crash() {
      for (const socket of [...sockets]) socket.drop();
      await gateway.drain().catch(() => {});
    },
  };
}

type Server = ReturnType<typeof openServer>;

/** A writing tab on `draft`, driven by a 50 ms typing loop the arms start and stop. */
async function openWriter(
  client: { openTab(roomName: string): Tab },
  draft: { branchId: string; generation: number },
) {
  const tab = client.openTab(`branch:${draft.branchId}:gen:${draft.generation}`);
  await within(5_000, async () => tab.loaded(), Boolean).catch((cause) => {
    const socket = PipeSocket.all.at(-1);
    throw new Error(
      `the tab never loaded: ${JSON.stringify({
        sockets: PipeSocket.all.length,
        readyState: socket?.readyState,
        sent: socket?.sent.map((f) => [f.type, f.sub]),
        received: socket?.received.map((f) => [f.type, f.sub]),
        closed: socket?.closedWith,
        states: tab.states,
      })}`,
      { cause },
    );
  });
  const tokens: string[] = [];
  let typing = false;
  let loop: Promise<void> = Promise.resolve();
  return {
    tab,
    tokens,
    /** Types `count` keys, one every 50 ms (or all at once with `burst`). */
    async typeKeys(count: number, burst = false) {
      for (let index = 0; index < count; index += 1) {
        const token = ` k${String(tokens.length).padStart(3, "0")}`;
        tokens.push(token);
        tab.type(token);
        if (!burst) await sleep(KEY_MS);
      }
    },
    start() {
      typing = true;
      loop = (async () => {
        while (typing) await this.typeKeys(1);
      })();
    },
    async stop() {
      typing = false;
      await loop;
    },
  };
}

/** Waits for every key to be acknowledged, then checks the arm's shared invariants. */
async function settleAndCheck(
  harness: Harness,
  label: string,
  draft: { branchId: string },
  writer: Awaited<ReturnType<typeof openWriter>>,
  sockets: PipeSocket[],
  options: { lost?: readonly string[] } = {},
) {
  const { tab, tokens } = writer;
  await within(
    15_000,
    async () => ({ outbox: tab.unacknowledged() === null, saved: tab.acknowledged() }),
    (s) => s.outbox && s.saved,
  );
  const durable = (await harness.readBranch(draft.branchId)).text;
  const rows = await journalRows(harness, draft.branchId);
  const parts = (await receipts(harness, draft.branchId)).flat();
  const clocks = new Map<string, number>();
  for (const row of rows)
    for (const struct of Y.decodeUpdate(row.update).structs)
      for (let n = 0; n < struct.length; n += 1) {
        const id = `${struct.id.client}:${struct.id.clock + n}`;
        clocks.set(id, (clocks.get(id) ?? 0) + 1);
      }
  const twice = [...clocks].filter(([, count]) => count > 1).map(([id]) => id);
  const unreceipted = rows
    .filter((row) => !parts.some((part) => part.rowId === row.id))
    .map((row) => row.id);
  const closes = sockets.flatMap((s) =>
    s.closedWith && s.closedWith.by === "server" ? [s.closedWith.code] : [],
  );
  const branchSockets = sockets.filter((s) => s.sent.some((f) => f.room.startsWith("branch:")));
  const wire = branchSockets.map((s) => s.syncKinds().slice(0, 3).join(","));
  const lost = new Set(options.lost ?? []);
  const surviving = tokens.filter((token) => !lost.has(token));
  const positions = surviving.map((token) => durable.indexOf(token));
  observe(label, {
    keys: tokens.length,
    sockets: sockets.length,
    serverCloses: closes,
    terminal: tab.states.filter((s) => s.kind === "terminal"),
    rows: rows.length,
    rowStructs: rows.slice(-4).map((row) => structsOf(row.update)),
    twice,
    unreceipted,
    wire,
    firstAckMs: percentiles(
      branchSockets.flatMap((s) => (s.firstAckMs() === null ? [] : [s.firstAckMs() as number])),
    ),
  });
  assert.deepEqual(
    closes.filter((code) => code === 1008 || code === 4207),
    [],
    "no refusal and no resync",
  );
  assert.deepEqual(
    tab.states.filter((s) => s.kind === "terminal"),
    [],
    "no terminal state",
  );
  assert.equal(durable, tab.text(), "the durable draft is what the tab shows");
  for (const [index, token] of surviving.entries()) {
    assert.equal(durable.split(token).length, 2, `${token} durable exactly once`);
    if (index > 0)
      assert.ok((positions[index] ?? -1) > (positions[index - 1] ?? -1), `${token} in order`);
  }
  for (const token of lost)
    assert.ok(!durable.includes(token), `${token} was lost with the reload`);
  assert.deepEqual(twice, [], "no clock journaled twice: released echoes write nothing");
  assert.deepEqual(unreceipted, [], "every row has a receipt");
  for (const kinds of wire)
    assert.ok(
      kinds === "step1,step2,update" || kinds === "step1,step2" || kinds === "step1",
      `branch wire order: ${kinds}`,
    );
}

export const clientResync: Probe = {
  name: "client-resync",
  decision: "D30 (§2.7 R1/G1–G3)",
  expected:
    "(f)–(i): no 1008, no 4207, no terminal state, every key durable once in order, step1, step2 first on each branch socket; (k) the raw dependent Update closes 4207 and its SyncStep2 lands",
  async run(harness) {
    const globals = globalThis as { WebSocket: unknown; window?: unknown };
    const native = { WebSocket: globals.WebSocket, window: globals.window };
    globals.WebSocket = PipeSocket;
    // The transport builds its same-origin socket URL from the page's location.
    globals.window = {
      location: { protocol: "https:", host: "probe.invalid", origin: "https://probe.invalid" },
    };
    try {
      // After the pipe is installed: the transport's socket class extends the global at load.
      const client = await loadClient();
      await runArms({
        async "f-three-drops-behind-a-held-frame"() {
          const draft = await seedDraft(harness, "resync-drops");
          const server: Server = openServer(harness, draft.workId);
          PipeSocket.connector = (socket) => server.accept(socket);
          const first = PipeSocket.all.length;
          const writer = await openWriter(client, draft);
          try {
            writer.start();
            for (let drop = 0; drop < 3; drop += 1) {
              await sleep(600);
              const pause = pauseAt("branch.append.beforeCommit");
              try {
                await deadline(pause.entered, 10_000, "a held append");
                const socket = PipeSocket.all.at(-1);
                socket?.drop();
                // The next connection's SyncStep2 queues on the row the held frame owns.
                await harness.waitForLockWaiter(/document_branches/, 10_000);
              } finally {
                pause.remove();
              }
            }
            await sleep(600);
            await writer.stop();
            await settleAndCheck(harness, "f", draft, writer, PipeSocket.all.slice(first));
          } finally {
            await writer.stop();
            writer.tab.destroy();
            await server.crash();
            draft.live.destroy();
          }
        },

        async "g-partial-acknowledgement"() {
          const draft = await seedDraft(harness, "resync-partial");
          const server = openServer(harness, draft.workId);
          PipeSocket.connector = (socket) => server.accept(socket);
          const first = PipeSocket.all.length;
          const writer = await openWriter(client, draft);
          try {
            await writer.typeKeys(2);
            await within(5_000, async () => writer.tab.acknowledged(), Boolean);
            // Hold the fourth of the next five keys' appends: three acknowledged, one held
            // uncommitted, one queued behind it on the connection.
            let appends = 0;
            const held = pauseAt("branch.append.beforeCommit", () => appends++ === 3);
            await writer.typeKeys(5, true);
            await deadline(held.entered, 10_000, "the fourth append held");
            const socket = PipeSocket.all.at(-1);
            const acks = socket?.received.filter((f) => f.type === 8).length ?? 0;
            socket?.drop();
            await harness.waitForLockWaiter(/document_branches/, 10_000);
            held.remove();
            await writer.typeKeys(2);
            observe("g acks before the drop", acks);
            await settleAndCheck(harness, "g", draft, writer, PipeSocket.all.slice(first));
          } finally {
            writer.tab.destroy();
            await server.crash();
            draft.live.destroy();
          }
        },

        async "h-server-restart-mid-burst"() {
          const draft = await seedDraft(harness, "resync-restart");
          let server = openServer(harness, draft.workId);
          PipeSocket.connector = (socket) => server.accept(socket);
          const first = PipeSocket.all.length;
          const writer = await openWriter(client, draft);
          try {
            writer.start();
            await sleep(1_000);
            const old = server;
            server = openServer(harness, draft.workId);
            await old.crash();
            await sleep(2_500);
            await writer.stop();
            await settleAndCheck(harness, "h", draft, writer, PipeSocket.all.slice(first));
          } finally {
            await writer.stop();
            writer.tab.destroy();
            await server.crash();
            draft.live.destroy();
          }
        },

        async "i-offline-reload"() {
          const draft = await seedDraft(harness, "resync-reload");
          const server = openServer(harness, draft.workId);
          PipeSocket.connector = (socket) => server.accept(socket);
          const first = PipeSocket.all.length;
          const before = await openWriter(client, draft);
          let after: Awaited<ReturnType<typeof openWriter>> | undefined;
          try {
            await before.typeKeys(3);
            await within(5_000, async () => before.tab.acknowledged(), Boolean);
            PipeSocket.connector = null;
            PipeSocket.all.at(-1)?.drop();
            await before.typeKeys(3);
            const lost = before.tokens.slice(-3);
            before.tab.destroy();
            PipeSocket.connector = (socket) => server.accept(socket);
            after = await openWriter(client, draft);
            after.tokens.push(...before.tokens);
            await after.typeKeys(3);
            await settleAndCheck(harness, "i", draft, after, PipeSocket.all.slice(first), { lost });
          } finally {
            after?.tab.destroy();
            await server.crash();
            draft.live.destroy();
          }
        },

        async "k-raw-client-dependent-update"() {
          const draft = await seedDraft(harness, "resync-raw");
          const server = openServer(harness, draft.workId);
          PipeSocket.connector = (socket) => server.accept(socket);
          const room = `branch:${draft.branchId}:gen:${draft.generation}`;
          const peer = new Y.Doc({ gc: false });
          peer.clientID = 970_001;
          Y.applyUpdate(peer, Y.encodeStateAsUpdate(draft.live));
          const paragraph = peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
          const text = paragraph.get(0) as Y.XmlText;
          const before = Y.encodeStateVector(peer);
          text.insert(text.length, "A");
          const middle = Y.encodeStateVector(peer);
          text.insert(text.length, "B");
          const u2 = Y.encodeStateAsUpdate(peer, middle);
          try {
            const raw = async (frames: Uint8Array[]) => {
              const socket = new PipeSocket("wss://probe.invalid/ws/yjs", [
                formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION),
              ]);
              await within(
                2_000,
                async () => socket.readyState,
                (state) => state === 1,
              );
              for (const frame of frames) socket.send(frame);
              await within(
                5_000,
                async () => socket.closedWith !== null || socket.received.some((f) => f.type === 8),
                Boolean,
              );
              await sleep(50);
              return socket;
            };
            const first = await raw([
              auth(room),
              sync(room, 0, Y.encodeStateVector(peer)),
              sync(room, 2, u2),
            ]);
            const second = await raw([
              auth(room),
              sync(room, 0, Y.encodeStateVector(peer)),
              sync(room, 1, Y.encodeStateAsUpdate(peer, before)),
            ]);
            const durable = (await harness.readBranch(draft.branchId)).text;
            observe("k", {
              first: first.closedWith,
              prefixMissing: server.prefixMissing.length,
              secondClosed: second.closedWith,
              acks: second.received.filter((f) => f.type === 8).length,
              durable,
            });
            assert.equal(first.closedWith?.code, 4207);
            assert.equal(second.closedWith, null);
            assert.match(durable, /BaseAB/);
            second.close();
          } finally {
            peer.destroy();
            await server.crash();
            draft.live.destroy();
          }
        },
      });
    } finally {
      PipeSocket.connector = null;
      globals.WebSocket = native.WebSocket;
      globals.window = native.window;
    }
  },
};

function frame(room: string, write: (encoder: unknown) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, room);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

/** The provider's Auth message (no token), as it sends on every open. */
function auth(room: string): Uint8Array {
  return frame(room, (encoder) => {
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarUint(encoder, 0);
    encoding.writeVarString(encoder, "");
  });
}

/** A Sync frame: `sub` 0 SyncStep1 (a state vector), 1 SyncStep2, 2 Update. */
function sync(room: string, sub: number, payload: Uint8Array): Uint8Array {
  return frame(room, (encoder) => {
    encoding.writeVarUint(encoder, 0);
    encoding.writeVarUint(encoder, sub);
    encoding.writeVarUint8Array(encoder, payload);
  });
}
