/** Platform-neutral socket, recovery, and observation boundaries. */
export interface SocketClose {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface SocketEvents {
  open: object;
  message: { data: unknown };
  error: object;
  close: SocketClose;
}

export interface SocketLike {
  readonly readyState: number;
  addEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ConnectivityHint = "retry-now" | "suspect-offline";
export interface ConnectivityHintsPort {
  subscribe(source: object, listener: (hint: ConnectivityHint) => void): () => void;
  reportConnected(source: object): void;
  reportDisconnected(source: object): void;
}

export interface ThreadSocketObserver {
  onStringFrame(
    direction: "client_to_server" | "server_to_client",
    data: string,
    generation: number,
  ): void;
  onSocketOpen(generation: number): void;
  onSocketClose(generation: number, code: number, wasClean: boolean): void;
}
