/** In-memory thread WebSocket boundary for real ThreadSocketClient tests. */
import { encodeWsServerMessage, parseWsClientMessage } from "@meridian/contracts/protocol";

import type { SocketEvents, SocketLike } from "../socket/socket-ports";

export class FakeThreadSocket implements SocketLike {
  private readonly target = new EventTarget();

  addEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ): void {
    this.target.addEventListener(type, listener as EventListener);
  }
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  stallClose = false;
  readonly sent: string[] = [];

  constructor(
    private readonly onSend: (socket: FakeThreadSocket, frame: unknown) => void = () => {},
  ) {}

  send(data: string): void {
    this.sent.push(data);
    const frame = parseWsClientMessage(data);
    if (frame) this.onSend(this, frame);
  }

  open(): void {
    this.readyState = 1;
    this.target.dispatchEvent(new Event("open"));
  }

  close(code = 1000, reason = ""): void {
    this.readyState = this.stallClose ? 2 : 3;
    if (this.stallClose) return;
    this.target.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: true }));
  }

  deliver(message: unknown): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: encodeWsServerMessage(message as never) });
    this.target.dispatchEvent(event);
  }
}
