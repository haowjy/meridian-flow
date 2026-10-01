/** In-memory thread WebSocket boundary for real WsThreadTransport tests. */
import { encodeWsServerMessage, parseWsClientMessage } from "@meridian/contracts/protocol";

export class FakeThreadSocket extends EventTarget {
  readyState = 0;
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

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  deliver(message: unknown): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: encodeWsServerMessage(message as never) });
    this.dispatchEvent(event);
  }
}
