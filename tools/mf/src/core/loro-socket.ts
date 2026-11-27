import {
  API_AUTH_ME_PATH,
  authIdentitySchema,
  createFrameReader,
  decodeLoroJoinExtra,
  docUpdateFrames,
  encodeLoroJoinAuth,
  freshBatchId,
  LORO_WS_PATH,
  type LoroJoinExtra,
} from "@meridian/contracts/protocol";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaVersion } from "@meridian/prosemirror-schema";
import {
  CrdtType,
  encode,
  MessageType,
  type Permission,
  type ProtocolMessage,
  UpdateStatusCode,
} from "loro-protocol";
import WebSocket from "ws";
import { CliError } from "./cli-error";
import { jsonResponse, type Session } from "./session";

const OPEN_TIMEOUT_MS = 15_000;
const ACK_TIMEOUT_MS = 15_000;

type Joined = {
  onBatch(envelope: Uint8Array): void;
  answer?: { resolve(value: JoinAnswer): void; reject(error: CliError): void };
};

export type JoinAnswer = { permission: Permission; version: Uint8Array; extra: LoroJoinExtra };

export class LoroSocket {
  private readonly read = createFrameReader();
  private readonly rooms = new Map<string, Joined>();
  private readonly acks = new Map<string, (status: number | CliError) => void>();
  private ended: CliError | null = null;

  private constructor(
    private readonly ws: WebSocket,
    private readonly account: string,
  ) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      let message: ProtocolMessage | null;
      try {
        message = this.read(new Uint8Array(data));
      } catch {
        return;
      }
      if (message) this.handle(message);
    });
    ws.on("close", (code, reason) =>
      this.end(new CliError("unavailable", `The room socket closed (${code} ${String(reason)})`)),
    );
  }

  static async open(session: Session): Promise<LoroSocket> {
    const me = await session.request("GET", API_AUTH_ME_PATH, undefined, {
      decode: jsonResponse(authIdentitySchema),
    });
    const ws = new WebSocket(`${session.serverUrl.replace(/^http/, "ws")}${LORO_WS_PATH}`, {
      ...(session.cookie ? { headers: { Cookie: session.cookie } } : {}),
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new CliError("unavailable", `The room socket did not open in ${OPEN_TIMEOUT_MS}ms`));
      }, OPEN_TIMEOUT_MS);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new LoroSocket(ws, me.user.userId));
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new CliError("unavailable", `The room socket did not open: ${error.message}`, {
            hint: "Is the stack up? Start it with `pnpm dev`.",
          }),
        );
      });
    });
  }

  join(
    roomId: string,
    input: { peer: string; version: Uint8Array; onBatch(envelope: Uint8Array): void },
  ): Promise<JoinAnswer> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.rooms.set(roomId, { onBatch: input.onBatch, answer: { resolve, reject } });
      this.ws.send(
        encode({
          type: MessageType.JoinRequest,
          crdt: CrdtType.Loro,
          roomId,
          auth: encodeLoroJoinAuth({
            schema: formatCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
            peer: input.peer,
            account: this.account,
          }),
          version: input.version,
        }),
      );
    });
  }

  send(roomId: string, envelope: Uint8Array): Promise<void> {
    if (this.ended) return Promise.reject(this.ended);
    const batchId = freshBatchId();
    const acked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(batchId);
        reject(new CliError("timeout", `The room did not acknowledge in ${ACK_TIMEOUT_MS}ms`));
      }, ACK_TIMEOUT_MS);
      this.acks.set(batchId, (status) => {
        clearTimeout(timer);
        this.acks.delete(batchId);
        if (status instanceof CliError) reject(status);
        else if (status === UpdateStatusCode.Ok) resolve();
        else reject(new CliError("http_error", `The room refused the batch (status ${status})`));
      });
    });
    for (const frame of docUpdateFrames(roomId, envelope, batchId)) this.ws.send(frame);
    return acked;
  }

  close() {
    this.rooms.clear();
    this.ws.close();
  }

  private handle(message: ProtocolMessage) {
    switch (message.type) {
      case MessageType.JoinResponseOk: {
        const room = this.rooms.get(message.roomId);
        room?.answer?.resolve({
          permission: message.permission,
          version: message.version,
          extra: decodeLoroJoinExtra(message.extra),
        });
        if (room) room.answer = undefined;
        return;
      }
      case MessageType.JoinError: {
        const room = this.rooms.get(message.roomId);
        this.rooms.delete(message.roomId);
        room?.answer?.reject(
          new CliError("unavailable", `The server refused to join ${message.roomId}`, {
            details: { appCode: message.appCode ?? message.message },
          }),
        );
        return;
      }
      case MessageType.DocUpdate:
        for (const update of message.updates) this.rooms.get(message.roomId)?.onBatch(update);
        return;
      case MessageType.Ack:
        this.acks.get(message.refId)?.(message.status);
        return;
      case MessageType.RoomError:
        this.rooms.delete(message.roomId);
        this.end(
          new CliError("unavailable", `The server ended ${message.roomId}: ${message.message}`),
        );
        return;
      default:
        return;
    }
  }

  private end(error: CliError) {
    this.ended ??= error;
    for (const ack of [...this.acks.values()]) ack(error);
    for (const room of this.rooms.values()) room.answer?.reject(error);
    this.rooms.clear();
  }
}
