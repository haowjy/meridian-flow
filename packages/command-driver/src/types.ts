import type { CommandOutcome } from "@meridian/contracts/commands";

/** What a command came to, as the server stored it. A server `refused` reads as `never`. */
export type Outcome = { status: "done"; result: unknown } | { status: "never"; result?: unknown };

export type CommandState = "sending" | "done" | "never";

/**
 * One command the writer asked for. `id` and `seq` never change; `sendId` is what the server
 * sees and changes only on `retry`, since the server keeps a `never` under the old one.
 */
export type CommandRecord<Body = unknown> = {
  id: string;
  /** Commit order in the account's journal: a record is never ordered ahead of an earlier commit. */
  seq: number;
  kind: string;
  /** Ordered after every earlier unsettled record that shares a lane. */
  lanes: readonly string[];
  sendId: string;
  body: Body;
  bodyVersion: number;
  /**
   * The request as first sent, saved with `sent`. A resend repeats it byte for byte: the server
   * digests the body, so a sent record is never migrated or rebuilt.
   */
  request?: HttpRequest;
  /** Saved as true before the first request leaves: from then on the server may have it. */
  sent: boolean;
  state: CommandState;
  outcome?: Outcome;
  /** A read of the domain's own data that started after the record settled has included it. */
  observed: boolean;
  attempts: number;
  /** Submitted at. */
  since: number;
  settledAt?: number;
};

export type HttpRequest = {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  /** An object: the driver adds `commandId`. */
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
  /** The structured error code of a failed answer, when it carries one. */
  code: string | null;
};

/** One HTTP exchange. Throws when the request got no answer (network, deadline, abort). */
export type Transport = (
  request: TransportRequest,
  signal: AbortSignal,
) => Promise<TransportAnswer>;

export type CommandKind<Body = unknown> = {
  /** Changes whenever `Body` does; an unsent record is migrated just before it first leaves. */
  version: number;
  migrate(body: unknown, from: number): Body;
  request(record: Pick<CommandRecord<Body>, "id" | "body">): HttpRequest;
  /**
   * Every tab runs this once for each record it sees settle (also for one settled before it
   * opened), so it must be safe in every tab and safe to run twice. Call `observed` once a
   * read of your own data that started after the record settled has come back.
   */
  onSettled?(record: CommandRecord<Body>, ctx: { observed(id: string): void }): void;
};

export type JournalState = { records: readonly CommandRecord[]; nextSeq: number };
export type JournalChange = {
  put?: readonly CommandRecord[];
  remove?: readonly string[];
  nextSeq?: number;
};

/**
 * The account's stored records. `transact` is one transaction that no other transaction
 * interleaves with, in this tab or another: it reads everything, `decide` runs on that and
 * returns what to write, and the write commits with it.
 */
export interface Journal {
  transact<R>(decide: (state: JournalState) => { change: JournalChange; result: R }): Promise<R>;
  read(): Promise<readonly CommandRecord[]>;
  close(): void;
}

/** The account-wide right to deliver. Resolves with its release once this tab holds it. */
export interface DeliveryLock {
  acquire(signal: AbortSignal): Promise<() => void>;
}

/** Tells the account's other tabs that the journal changed. */
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
  kinds: Readonly<Record<string, CommandKind>>;
  /** A failure worth keeping: carries the id, kind, attempt and failure class, never a body. */
  log(entry: { id: string; kind: string; attempt: number; failure: string }): void;
};

export type DriverSnapshot = {
  /** Every stored record of the account, oldest first. */
  records: readonly CommandRecord[];
  /** Something has gone unanswered for a while, or the browser is offline with something waiting. */
  notSent: boolean;
  /** The server turned this account's requests away; delivery waits for a sign-in. */
  paused: boolean;
};

export type WireOutcome = CommandOutcome;
