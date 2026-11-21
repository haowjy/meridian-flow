// loro-protocol DocUpdate with fragmentation: a frame is capped at 256 KB, so a large update (a join's catch-up
// of a long-typed chapter) goes as DocUpdateFragmentHeader + DocUpdateFragment frames and is reassembled.
import { CrdtType, decode, encode, MessageType } from "loro-protocol";

const FRAGMENT = 200 * 1024;
export function sendUpdates(ws, roomId, updates, batchId) {
  if (ws.readyState !== 1) return;
  const size = updates.reduce((a, u) => a + u.length, 0);
  if (size < FRAGMENT) {
    ws.send(encode({ type: MessageType.DocUpdate, crdt: CrdtType.Loro, roomId, updates, batchId }));
    return;
  }
  // Each update is fragmented on its own; all but the last carry a derived batch id and no ack is expected for them.
  updates.forEach((u, k) => {
    const id =
      k === updates.length - 1
        ? batchId
        : `0x${(BigInt(batchId) ^ (BigInt(k + 1) << 56n)).toString(16).padStart(16, "0")}`;
    if (u.length < FRAGMENT) {
      ws.send(
        encode({
          type: MessageType.DocUpdate,
          crdt: CrdtType.Loro,
          roomId,
          updates: [u],
          batchId: id,
        }),
      );
      return;
    }
    const count = Math.ceil(u.length / FRAGMENT);
    ws.send(
      encode({
        type: MessageType.DocUpdateFragmentHeader,
        crdt: CrdtType.Loro,
        roomId,
        batchId: id,
        fragmentCount: count,
        totalSizeBytes: u.length,
      }),
    );
    for (let i = 0; i < count; i++)
      ws.send(
        encode({
          type: MessageType.DocUpdateFragment,
          crdt: CrdtType.Loro,
          roomId,
          batchId: id,
          index: i,
          fragment: u.subarray(i * FRAGMENT, (i + 1) * FRAGMENT),
        }),
      );
  });
}

// Returns a decoder that turns fragment frames back into one DocUpdate message; other messages pass through.
export function receiver() {
  const parts = new Map();
  return (data) => {
    const msg = decode(new Uint8Array(data));
    if (msg.type === MessageType.DocUpdateFragmentHeader) {
      parts.set(msg.batchId, {
        total: msg.totalSizeBytes,
        data: new Array(msg.fragmentCount),
        got: 0,
      });
      return null;
    }
    if (msg.type !== MessageType.DocUpdateFragment) return msg;
    const p = parts.get(msg.batchId);
    p.data[msg.index] = msg.fragment;
    if (++p.got < p.data.length) return null;
    parts.delete(msg.batchId);
    const all = new Uint8Array(p.total);
    let o = 0;
    for (const f of p.data) {
      all.set(f, o);
      o += f.length;
    }
    return {
      type: MessageType.DocUpdate,
      crdt: msg.crdt,
      roomId: msg.roomId,
      updates: [all],
      batchId: msg.batchId,
    };
  };
}
