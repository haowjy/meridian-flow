/** Native socket boundary for real Hocuspocus document-provider tests. */
import { MessageType } from "@hocuspocus/provider";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { writeSyncStep1, writeSyncStep2 } from "y-protocols/sync";
import type * as Y from "yjs";

type Handler = (event: unknown) => void;

export class DocumentSocketHarness {
  static readonly instances: DocumentSocketHarness[] = [];
  readonly url: string;
  readonly protocols?: string | string[];
  readonly sent: Uint8Array[] = [];
  readyState = 0;
  binaryType = "blob";
  closeCalls = 0;
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = url.toString();
    this.protocols = protocols;
    DocumentSocketHarness.instances.push(this);
  }

  addEventListener(name: string, handler: Handler) {
    const listeners = this.handlers.get(name) ?? new Set();
    listeners.add(handler);
    this.handlers.set(name, listeners);
  }

  removeEventListener(name: string, handler: Handler) {
    this.handlers.get(name)?.delete(handler);
  }

  send(bytes: Uint8Array) {
    this.sent.push(bytes.slice());
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  /** Enter CLOSING without delivering close; queued writes remain observable. */
  stallClose() {
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  /** Settle Hocuspocus's connection attempt with the first server frame. */
  connected() {
    this.open();
    this.dispatch("message", { data: new Uint8Array([MessageType.Ping]).buffer });
  }

  deliverClose(code = 1006, reason = "") {
    this.readyState = 3;
    this.dispatch("close", { code, reason });
  }

  receive(room: string, type: number, write: (encoder: encoding.Encoder) => void) {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, room);
    encoding.writeVarUint(encoder, type);
    write(encoder);
    const bytes = encoding.toUint8Array(encoder);
    this.dispatch("message", {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  syncStep1(room: string, serverDocument: Y.Doc) {
    this.receive(room, 0, (encoder) => writeSyncStep1(encoder, serverDocument));
  }

  syncStep2(room: string, serverDocument: Y.Doc, stateVector: Uint8Array) {
    this.receive(room, 0, (encoder) => writeSyncStep2(encoder, serverDocument, stateVector));
  }

  acknowledge(room: string, applied = true) {
    this.receive(room, 8, (encoder) => encoding.writeVarUint(encoder, applied ? 1 : 0));
  }

  private dispatch(name: string, event: unknown) {
    for (const handler of this.handlers.get(name) ?? []) handler(event);
  }
}

/** Independent wire oracle: exclude auth, awareness and SyncStep1 frames. */
export function sentSyncKinds(socket: DocumentSocketHarness): Array<"step2" | "update"> {
  const kinds: Array<"step2" | "update"> = [];
  for (const bytes of socket.sent) {
    const decoder = decoding.createDecoder(bytes);
    decoding.readVarString(decoder);
    if (decoding.readVarUint(decoder) !== 0) continue;
    const syncType = decoding.readVarUint(decoder);
    if (syncType === 1) kinds.push("step2");
    if (syncType === 2) kinds.push("update");
  }
  return kinds;
}
