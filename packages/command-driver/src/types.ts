import type { CommandOutcome } from "@meridian/contracts/commands";

/** What a command came to, as the server stored it. A server `refused` reads as `never`. */
export type Outcome =
  | { status: "done"; result: unknown }
  /** `code` is the structured error code of the attempt that was turned away, when it had one. */
  | { status: "never"; result?: unknown; code?: string };

export type CommandState = "sending" | "done" | "never";

/**
 * One command the writer asked for. `id` never changes. `sendId` is what the server sees and
 * changes only on `retry`, since the server keeps a `never` under the old one; `seq` changes on a
 * retry only when a later record of the same lanes was already sent, so a lane is never sent out of order.
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
   * A refused record of this kind keeps its lanes closed to later records until it is retried
   * or dismissed, instead of releasing them. For a command later ones depend on succeeding.
   */
  holdsLane?: boolean;
  /**
   * What a record of this kind waits for before each send, a reload's included: the record is
   * journaled and shown at once, and leaves once this resolves. A press waits for the edits the
   * tab sent before it to be acknowledged, so the server presses what the writer saw.
   */
  ready?(record: CommandRecord<Body>, signal: AbortSignal): Promise<void>;
  /**
   * Every tab runs this once for each record it sees settle (also for one settled before it
   * opened), so it must be safe in every tab and safe to run twice. The domain then reads its
   * own data and tells the driver through `observe` which outcomes that read included.
   */
  onSettled?(record: CommandRecord<Body>): void;
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
  /** The app asks that no new request leave (a reload is on its way); records wait in the journal. */
  held(): boolean;
  /** The server answered a command's resolve with 400, the answer to a body it cannot parse: it cannot read what this code sends. */
  unreadable(): void;
  /** The server's lookup and resolve routes for a command id. */
  routes: { lookup(sendId: string): string; resolve(sendId: string): string };
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
