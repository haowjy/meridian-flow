/** In-memory thread WebSocket boundary for real WsThreadTransport tests. */
import { encodeWsServerMessage, parseWsClientMessage } from "@meridian/contracts/protocol";

export class FakeThreadSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  stallClose = false;
  readonly sent: string[] = [];

  constructor(
    private readonly onSend: (socket: FakeThreadSocket, frame: unknown) => void = () => {},
  ) {
    super();
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = parseWsClientMessage(data);
    if (frame) this.onSend(this, frame);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  close(code = 1000, reason = ""): void {
    this.readyState = this.stallClose ? 2 : 3;
    if (this.stallClose) return;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: true }));
  }

  deliver(message: unknown): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: encodeWsServerMessage(message as never) });
    this.dispatchEvent(event);
  }
}
