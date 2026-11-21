// Gate 4 room server: loro-protocol frames over WebSocket, one LoroDoc per loaded room, debounced snapshots
// (2 s after the last batch, at most 10 s after the first) into document_snapshots, explicit flush before an
// AI turn's or a press's ack, merge-before-save. A keystroke batch is imported and acked with no DB write.
// node gate4/server.mjs <port> <databaseUrl> <name>

import { appendFileSync } from "node:fs";
import http from "node:http";
import { LoroDoc, LoroList, LoroMap, LoroText, VersionVector } from "loro-crdt";
import { CrdtType, encode, MessageType, UpdateStatusCode } from "loro-protocol";
import postgres from "postgres";
import { WebSocketServer } from "ws";
import { configure } from "../lib/chapter.mjs";
import { receiver, sendUpdates } from "../lib/frames.mjs";

const [port, dbUrl, name] = [Number(process.argv[2]), process.argv[3], process.argv[4] ?? "s"];
const LOG = process.env.GATE4_LOG;
const sql = postgres(dbUrl, { max: 4, onnotice: () => {} });
const log = (o) => {
  if (LOG)
    appendFileSync(
      LOG,
      `${JSON.stringify({ server: name, pid: process.pid, wall: Date.now(), ...o })}\n`,
    );
};
const freshPeer = () =>
  String(
    BigInt(Math.floor(Math.random() * 2 ** 52)) * 4096n + BigInt(Math.floor(Math.random() * 4096)),
  );

const rooms = new Map(); // key -> { doc, sockets:Set, firstAt, timer, seq, savedSeq, saving: Promise }
async function loadRoom(key) {
  let room = rooms.get(key);
  if (room) return room.ready;
  room = {
    doc: new LoroDoc(),
    sockets: new Set(),
    firstAt: 0,
    timer: null,
    seq: 0,
    savedSeq: 0,
    saving: Promise.resolve(),
  };
  rooms.set(key, room);
  room.ready = (async () => {
    const [row] = await sql`select snapshot from document_snapshots where room_key = ${key}`;
    if (row) room.doc.import(row.snapshot);
    room.doc.setPeerId(freshPeer());
    configure(room.doc);
    log({ ev: "load", room: key, bytes: row?.snapshot.length ?? 0 });
    return room;
  })();
  return room.ready;
}

// One save path for the debounce, commands and shutdown: lock the document, import a newer stored snapshot first
// (deploy overlap), then upsert this room's snapshot, all in one transaction. `extra` is a command's update.
function save(key, reason, extra) {
  const room = rooms.get(key);
  const run = room.saving.then(async () => {
    clearTimeout(room.timer);
    room.timer = null;
    const started = performance.now();
    let merged = false,
      bytes,
      seq,
      exportMs;
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const [cur] = await tx`select frontiers from document_snapshots where room_key = ${key}`;
      if (cur && !knows(room.doc, cur.frontiers)) {
        const [row] = await tx`select snapshot from document_snapshots where room_key = ${key}`;
        // What the merge brings must reach the room's sockets too: a tab rejoining only resends what the room
        // lacks, so ops the room got from the stored snapshot would otherwise reach no connected tab.
        const before = room.doc.oplogVersion();
        room.doc.import(row.snapshot);
        merged = true;
        room.seq++;
        broadcast(room, key, [room.doc.export({ mode: "update", from: before })]);
      }
      const e = performance.now();
      let src = room.doc;
      if (extra) {
        src = room.doc.fork();
        src.import(extra);
      }
      bytes = src.export({ mode: "snapshot" });
      seq = room.seq;
      const frontiers = src.frontiers();
      exportMs = performance.now() - e;
      await tx`insert into document_snapshots (room_key, snapshot, frontiers, saved_at) values (${key}, ${bytes}, ${tx.json(frontiers)}, now())
               on conflict (room_key) do update set snapshot = excluded.snapshot, frontiers = excluded.frontiers, saved_at = excluded.saved_at`;
      if (src !== room.doc) src.free();
    });
    room.savedSeq = Math.max(room.savedSeq, seq);
    if (room.seq === room.savedSeq) room.firstAt = 0;
    else schedule(key);
    log({
      ev: "save",
      room: key,
      reason,
      ms: +(performance.now() - started).toFixed(2),
      exportMs: +exportMs.toFixed(2),
      bytes: bytes.length,
      merged,
      vv: room.doc.oplogVersion().toJSON() && Object.fromEntries(room.doc.oplogVersion().toJSON()),
    });
  });
  room.saving = run.catch((e) => log({ ev: "save-error", room: key, error: String(e) }));
  return run;
}
// frontiersToVV throws ("Frontiers not found") for ids the doc lacks, though the 1.18 changelog says undefined.
function knows(doc, frontiers) {
  try {
    return doc.frontiersToVV(frontiers) !== undefined;
  } catch {
    return false;
  }
}
function schedule(key) {
  const room = rooms.get(key);
  const now = Date.now();
  if (!room.firstAt) room.firstAt = now;
  clearTimeout(room.timer);
  room.timer = setTimeout(
    () => save(key, "debounce"),
    Math.max(0, Math.min(now + 2000, room.firstAt + 10000) - now),
  );
}
const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(encode(msg));
};
const NO_ACK = "0x0000000000000000";
const broadcast = (room, key, updates, except) => {
  for (const s of room.sockets) if (s !== except) sendUpdates(s, key, updates, NO_ACK);
};

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  const joined = new Set();
  const read = receiver();
  ws.on("message", async (data) => {
    const msg = read(data);
    if (!msg) return;
    const key = msg.roomId;
    if (msg.type === MessageType.JoinRequest) {
      const room = await loadRoom(key);
      room.sockets.add(ws);
      joined.add(key);
      const clientVV = msg.version.length
        ? VersionVector.decode(msg.version)
        : new VersionVector(null);
      send(ws, {
        type: MessageType.JoinResponseOk,
        crdt: CrdtType.Loro,
        roomId: key,
        permission: "write",
        version: room.doc.oplogVersion().encode(),
      });
      const lacks = room.doc.export({ mode: "update", from: clientVV });
      sendUpdates(ws, key, [lacks], NO_ACK);
      log({ ev: "join", room: key, sentBytes: lacks.length });
    } else if (msg.type === MessageType.DocUpdate) {
      const room = await loadRoom(key);
      for (const u of msg.updates) room.doc.import(u);
      room.seq++;
      send(ws, {
        type: MessageType.Ack,
        crdt: CrdtType.Loro,
        roomId: key,
        refId: msg.batchId,
        status: UpdateStatusCode.Ok,
      });
      broadcast(room, key, msg.updates, ws);
      schedule(key);
    } else if (msg.type === MessageType.Leave) {
      rooms.get(key)?.sockets.delete(ws);
      joined.delete(key);
    }
  });
  ws.on("close", () => {
    for (const key of joined) rooms.get(key)?.sockets.delete(ws);
  });
});

// A command (AI turn or press): compute its update on a fork, flush the snapshot including it in the command's
// transaction, then import into the room and answer. The answer is the ack: it comes after the commit.
let commandN = 0;
async function command(key, kind) {
  const room = await loadRoom(key);
  const fork = room.doc.fork();
  fork.setPeerId(freshPeer());
  configure(fork);
  const before = fork.oplogVersion();
  const children = fork.getMap("doc").get("children");
  const marker = `${kind.toUpperCase()}-${name}-${++commandN}-${Date.now()}`;
  const node = children.insertContainer(children.length, new LoroMap());
  node.set("nodeName", "paragraph");
  node.setContainer("attributes", new LoroMap()).set("id", marker);
  const text = node.setContainer("children", new LoroList()).insertContainer(0, new LoroText());
  text.insert(
    0,
    kind === "ai"
      ? `${marker} ${"The rain had not stopped since the harbour bells. ".repeat(40)}`
      : `${marker} pressed into Live.`,
  );
  if (kind === "press") text.mark({ start: 0, end: marker.length }, "bold", true);
  fork.commit({ message: `${kind} ${marker}` });
  const update = fork.export({ mode: "update", from: before });
  fork.free();
  const t = performance.now();
  await save(key, kind, update);
  room.doc.import(update);
  room.seq++;
  broadcast(room, key, [update]);
  schedule(key);
  return { marker, flushMs: +(performance.now() - t).toFixed(2), bytes: update.length };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    const key = url.searchParams.get("room");
    if (url.pathname === "/command") {
      const r = await command(key, url.searchParams.get("kind"));
      log({ ev: "command", room: key, ...r });
      res.end(JSON.stringify(r));
    } else if (url.pathname === "/flush") {
      await save(key, "flush");
      res.end("{}");
    } else if (url.pathname === "/state") {
      const room = await loadRoom(key);
      res.end(
        JSON.stringify({
          vv: Object.fromEntries(room.doc.oplogVersion().toJSON()),
          json: room.doc.toJSON(),
        }),
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
server.on("upgrade", (req, sock, head) =>
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req)),
);
server.listen(port, "127.0.0.1", () => {
  log({ ev: "listen", port });
  process.send?.({ t: "listening" });
  console.log(`${name} listening on ${port} pid ${process.pid}`);
});

// Graceful shutdown (the old process of a deploy): flush every room, then close the sockets.
process.on("SIGTERM", async () => {
  for (const key of rooms.keys()) await save(key, "shutdown");
  for (const c of wss.clients) c.close(1012, "restart");
  log({ ev: "shutdown" });
  await sql.end();
  process.exit(0);
});
