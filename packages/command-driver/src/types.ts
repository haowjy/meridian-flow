import type { CommandOutcome } from "@meridian/contracts/commands";

export type Outcome =
  | { status: "done"; result: unknown }
  | { status: "never"; result?: unknown; code?: string };

export type CommandState = "sending" | "done" | "never";

export type CommandRecord<Body = unknown> = {
  id: string;
  seq: number;
  kind: string;
  lanes: readonly string[];
  sendId: string;
  body: Body;
  bodyVersion: number;
  // keep: A sent request is immutable and replayed byte for byte because the server hashes its body
  request?: HttpRequest;
  sent: boolean;
  state: CommandState;
  outcome?: Outcome;
  observed: boolean;
  attempts: number;
  since: number;
  settledAt?: number;
};

export type HttpRequest = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body: Record<string, unknown>;
};

export type TransportRequest = {
  method: "GET" | HttpRequest["method"];
  path: string;
  body?: unknown;
};

export type TransportAnswer = {
  status: number;
  body: unknown;
  code: string | null;
};

export type Transport = (
  request: TransportRequest,
  signal: AbortSignal,
) => Promise<TransportAnswer>;

export type CommandKind<Body = unknown> = {
  version: number;
  migrate(body: unknown, from: number): Body;
  request(record: Pick<CommandRecord<Body>, "id" | "body">): HttpRequest;
  holdsLane?: boolean;
  ready?(record: CommandRecord<Body>, signal: AbortSignal): Promise<void>;
  onSettled?(record: CommandRecord<Body>): void;
};

export type JournalState = { records: readonly CommandRecord[]; nextSeq: number };
export type JournalChange = {
  put?: readonly CommandRecord[];
  remove?: readonly string[];
  nextSeq?: number;
};

export interface Journal {
  transact<R>(decide: (state: JournalState) => { change: JournalChange; result: R }): Promise<R>;
  read(): Promise<readonly CommandRecord[]>;
  close(): void;
}

export interface DeliveryLock {
  acquire(signal: AbortSignal): Promise<() => void>;
}

export interface ChangeChannel {
  post(): void;
  subscribe(listener: () => void): () => void;
  close(): void;
}

export type DriverPorts = {
  journal: Journal;
  lock: DeliveryLock;
  transport: Transport;
  changes: ChangeChannel;
  online(): boolean;
  held(): boolean;
  unreadable(): void;
  routes: { lookup(sendId: string): string; resolve(sendId: string): string };
  kinds: Readonly<Record<string, CommandKind>>;
  log(entry: { id: string; kind: string; attempt: number; failure: string }): void;
};

export type DriverSnapshot = {
  records: readonly CommandRecord[];
  notSent: boolean;
  paused: boolean;
};

export type WireOutcome = CommandOutcome;
