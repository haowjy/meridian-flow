/** Thread WebSocket client: cookie-authenticated, contract-validated frames, auto-pong, pull-based reads. */
import {
  API_THREADS_WS_PATH,
  parseWsServerMessage,
  type WsClientMessage,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import WebSocket from "ws";
import { CliError } from "./cli-error";
import type { Session } from "./session";

export interface ThreadSocket {
  send(message: WsClientMessage): void;
  /** Next non-ping frame; rejects with a timeout CliError once `deadlineAt` passes. */
  next(deadlineAt: number): Promise<WsServerMessage>;
  close(): void;
}

export function threadWsUrl(serverUrl: string): string {
  const url = new URL(API_THREADS_WS_PATH, serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function openThreadSocket(
  session: Session,
  timeoutMs = 10_000,
): Promise<ThreadSocket> {
  const socket = new WebSocket(threadWsUrl(session.serverUrl), {
    headers: session.cookie ? { cookie: session.cookie } : {},
    ...(session.ca ? { ca: session.ca } : {}),
    handshakeTimeout: timeoutMs,
  });
  const queue: WsServerMessage[] = [];
  const waiters: Array<{ resolve: (m: WsServerMessage) => void; reject: (e: Error) => void }> = [];
  let failure: CliError | null = null;

  const fail = (error: CliError) => {
    if (failure) return;
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };

  socket.on("message", (raw) => {
    const message = parseWsServerMessage(String(raw));
    if (!message) {
      fail(
        new CliError("protocol", `Unparseable thread socket frame: ${String(raw).slice(0, 200)}`),
      );
      return;
    }
    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" } satisfies WsClientMessage));
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queue.push(message);
  });
  socket.on("close", (code, reason) =>
    fail(
      new CliError(
        "unavailable",
        `Thread socket closed (${code}${reason.length ? ` ${reason}` : ""})`,
        {
          hint:
            code === 4401 || code === 1008 ? "The socket rejected the session cookie." : undefined,
        },
      ),
    ),
  );
  socket.on("error", (error) =>
    fail(
      new CliError("unavailable", `Thread socket error: ${error.message}`, {
        hint: "Start this worktree's stack with `pnpm dev`, then retry.",
      }),
    ),
  );

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) =>
      reject(
        new CliError("unavailable", `Cannot open thread socket: ${error.message}`, {
          hint: "Start this worktree's stack with `pnpm dev`, then retry.",
        }),
      ),
    );
  });

  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    next(deadlineAt) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const remaining = deadlineAt - Date.now();
        const entry = {
          resolve: (message: WsServerMessage) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(
          () => {
            const index = waiters.indexOf(entry);
            if (index >= 0) waiters.splice(index, 1);
            reject(new CliError("timeout", "Timed out waiting for thread events"));
          },
          Math.max(0, remaining),
        );
        waiters.push(entry);
      });
    },
    close() {
      socket.removeAllListeners("close");
      socket.close();
    },
  };
}
