// A simulated browser tab: its own LoroDoc and peer id, an IndexedDB-like append-only store on disk (every local
// and remote update is appended; reopening replays it), a WebSocket speaking loro-protocol that reconnects, and
// on join resends whatever the server's version vector lacks.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { LoroDoc, VersionVector } from "loro-crdt";
import { CrdtType, encode, MessageType } from "loro-protocol";
import { WebSocket } from "ws";
import { configure, keystroke } from "../lib/chapter.mjs";
import { receiver, sendUpdates } from "../lib/frames.mjs";

const freshPeer = () =>
  String(
    BigInt(Math.floor(Math.random() * 2 ** 52)) * 4096n + BigInt(Math.floor(Math.random() * 4096)),
  );

export class Store {
  constructor(path) {
    this.path = path;
    if (!existsSync(path)) writeFileSync(path, "");
  }
  append(u) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(u.length);
    appendFileSync(this.path, Buffer.concat([len, u]));
  }
  all() {
    const b = readFileSync(this.path);
    const out = [];
    for (let o = 0; o < b.length; ) {
      const n = b.readUInt32LE(o);
      out.push(new Uint8Array(b.subarray(o + 4, o + 4 + n)));
      o += 4 + n;
    }
    return out;
  }
}

export class Tab {
  constructor({ id, url, room, storePath, rng, reopen = false }) {
    Object.assign(this, { id, url, room, rng });
    this.store = new Store(storePath);
    this.doc = new LoroDoc();
    if (reopen) {
      const all = this.store.all();
      if (all.length) this.doc.importBatch(all);
    }
    this.doc.setPeerId(freshPeer());
    configure(this.doc); // a new session takes a fresh peer id
    this.peer = this.doc.peerIdStr;
    this.cur = { block: 3 + id * 7, offset: 0 };
    this.pending = [];
    this.inflight = new Map(); // batchId -> end counter of this peer in the batch
    this.acked = 0; // highest counter (exclusive) of this tab's own peer the server has acked
    this.ackLatency = [];
    this.connected = false;
    this.joined = false;
    this.closed = false;
    this.batchN = 0;
    this.keys = 0;
    this.keyLog = [];
    this.doc.subscribeLocalUpdates((u) => {
      this.store.append(u);
      this.pending.push(u);
    });
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "nodebuffer";
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      ws.send(
        encode({
          type: MessageType.JoinRequest,
          crdt: CrdtType.Loro,
          roomId: this.room,
          auth: new Uint8Array(),
          version: this.doc.oplogVersion().encode(),
        }),
      );
    });
    const read = receiver();
    ws.on("message", (data) => {
      const msg = read(data);
      if (msg) this.onMessage(msg);
    });
    const retry = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.joined = false;
      this.inflight.clear();
      setTimeout(() => this.connect(), 200);
    };
    ws.on("close", retry);
    ws.on("error", () => {});
  }
  onMessage(msg) {
    if (msg.type === MessageType.JoinResponseOk) {
      // Resend from the local store what the server lacks: everything after the server's version vector.
      const serverVV = VersionVector.decode(msg.version);
      const missing = this.doc.export({ mode: "update", from: serverVV });
      this.joined = true;
      const mine = this.doc.oplogVersion().get(this.peer) ?? 0;
      this.resentOps = mine - (serverVV.get(this.peer) ?? 0);
      if (missing.length > 0) this.sendBatch([missing], mine);
    } else if (msg.type === MessageType.DocUpdate) {
      for (const u of msg.updates) {
        if (!u.length) continue;
        this.doc.import(u);
        this.store.append(u);
      }
    } else if (msg.type === MessageType.Ack) {
      const sent = this.inflight.get(msg.refId);
      if (sent) {
        this.inflight.delete(msg.refId);
        this.acked = Math.max(this.acked, sent.end);
        this.ackLatency.push(performance.now() - sent.at);
      }
    }
  }
  sendBatch(updates, end) {
    const batchId = `0x${(++this.batchN).toString(16).padStart(12, "0")}${this.id.toString(16).padStart(4, "0")}`;
    this.inflight.set(batchId, { end, at: performance.now() });
    sendUpdates(this.ws, this.room, updates, batchId);
  }
  type(n) {
    if (!this.doc.getMap("doc").get("children")) return; // nothing to type into before the first sync
    for (let i = 0; i < n; i++) {
      keystroke(this.doc, this.cur, this.rng);
      this.keys++;
      this.keyLog.push(Date.now());
    }
  }
  keysAt(wall) {
    let k = 0;
    for (const t of this.keyLog) if (t <= wall) k++;
    return k;
  }
  flush() {
    if (!this.pending.length) return;
    if (!this.joined) {
      this.pending = [];
      return;
    } // kept in the store and the doc; the join resend carries it
    this.sendBatch(this.pending, this.doc.oplogVersion().get(this.peer) ?? 0);
    this.pending = [];
  }
  setUrl(url) {
    this.url = url;
    const old = this.ws;
    this.ws = null;
    old.removeAllListeners("close");
    old.close();
    this.connected = this.joined = false;
    this.inflight.clear();
    this.connect();
  }
  close() {
    this.closed = true;
    this.ws?.removeAllListeners("close");
    this.ws?.close();
    this.doc.free();
  }
}
