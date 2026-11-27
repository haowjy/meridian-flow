import {
  CrdtType,
  decode,
  encode,
  type HexString,
  MAX_MESSAGE_SIZE,
  MessageType,
  type ProtocolMessage,
} from "loro-protocol";

export function docUpdateFrames(
  roomId: string,
  envelope: Uint8Array,
  batchId: HexString,
  crdt: CrdtType = CrdtType.Loro,
): Uint8Array[] {
  if (envelope.byteLength <= FRAGMENT_BYTES)
    return [
      encode({
        type: MessageType.DocUpdate,
        crdt,
        roomId,
        updates: [envelope],
        batchId,
      }),
    ];
  const count = Math.ceil(envelope.byteLength / FRAGMENT_BYTES);
  const frames = [
    encode({
      type: MessageType.DocUpdateFragmentHeader,
      crdt,
      roomId,
      batchId,
      fragmentCount: count,
      totalSizeBytes: envelope.byteLength,
    }),
  ];
  for (let index = 0; index < count; index++)
    frames.push(
      encode({
        type: MessageType.DocUpdateFragment,
        crdt,
        roomId,
        batchId,
        index,
        fragment: envelope.subarray(index * FRAGMENT_BYTES, (index + 1) * FRAGMENT_BYTES),
      }),
    );
  return frames;
}

const FRAGMENT_BYTES = MAX_MESSAGE_SIZE - 4096;

export function createFrameReader(): (data: Uint8Array) => ProtocolMessage | null {
  const parts = new Map<
    string,
    { roomId: string; total: number; data: Uint8Array[]; got: number }
  >();
  return (data) => {
    const message = decode(data);
    if (message.type === MessageType.DocUpdateFragmentHeader) {
      parts.set(`${message.roomId}\n${message.batchId}`, {
        roomId: message.roomId,
        total: message.totalSizeBytes,
        data: new Array(message.fragmentCount),
        got: 0,
      });
      return null;
    }
    if (message.type !== MessageType.DocUpdateFragment) return message;
    const key = `${message.roomId}\n${message.batchId}`;
    const part = parts.get(key);
    if (!part || part.data[message.index] !== undefined) return null;
    part.data[message.index] = message.fragment;
    if (++part.got < part.data.length) return null;
    parts.delete(key);
    const whole = new Uint8Array(part.total);
    let at = 0;
    for (const fragment of part.data) {
      whole.set(fragment, at);
      at += fragment.byteLength;
    }
    return {
      type: MessageType.DocUpdate,
      crdt: message.crdt,
      roomId: message.roomId,
      updates: [whole],
      batchId: message.batchId,
    };
  };
}

export function freshBatchId(crypto: Crypto = globalThis.crypto): HexString {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
