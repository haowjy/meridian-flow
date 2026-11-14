/**
 * `./mf` as a tree-list client: the project's list opened through the same package the browser
 * uses, records made with the package's writer, and the server's admission read back from a second
 * copy of the list. There is no route for a tree change: the list is the write path.
 */
import { type TreeListRef, treeRoomName } from "@meridian/contracts/protocol";
import {
  type CreateRecord,
  LIVE,
  lastSettlements,
  recordsOf,
  replayView,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
} from "@meridian/project-tree";
import { connectTreeList, type ListCopy, type ListSyncState } from "@meridian/tree-list-sync";
import * as Y from "yjs";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";
import { yjsSocketOptions } from "../../core/yjs-socket";

const SYNC_TIMEOUT_MS = 15_000;
const ADMISSION_TIMEOUT_MS = 15_000;
const POLL_MS = 50;

/** Ids below this are the server's; an admission refuses a client that uses one. */
const FIRST_CLIENT_ID = 1000;

function newDoc(): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  while (doc.clientID < FIRST_CLIENT_ID) doc.clientID = Math.floor(Math.random() * 2 ** 32);
  return doc;
}

/** A copy that lives as long as the command: the records a rebuild carries are kept in memory. */
class MemoryCopy implements ListCopy {
  doc = newDoc();
  private held: readonly TreeRecord[] = [];

  async replace(carried: readonly TreeRecord[]) {
    this.doc = newDoc();
    this.held = carried;
  }
  carried() {
    return this.held;
  }
  async settleCarried() {
    this.held = [];
  }
}

type Connection = {
  copy: MemoryCopy;
  /** Settles when the copy holds the server's list: `read-only` when the account cannot write it. */
  synced: Promise<"synced" | "read-only">;
  rejected: TreeRecord[];
  close(): void;
};

function connect(session: Session, list: TreeListRef): Connection {
  const copy = new MemoryCopy();
  const rejected: TreeRecord[] = [];
  let settle!: (result: "synced" | "read-only" | CliError) => void;
  const outcome = new Promise<"synced" | "read-only" | CliError>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(
    () =>
      settle(
        new CliError(
          "unavailable",
          `The project's tree list did not sync in ${SYNC_TIMEOUT_MS}ms`,
          {
            hint: "Is the stack up? Start it with `pnpm dev`.",
          },
        ),
      ),
    SYNC_TIMEOUT_MS,
  );
  const onState = (state: ListSyncState) => {
    if (state === "synced" || state === "read-only") settle(state);
    if (state === "denied")
      settle(new CliError("unavailable", "This account has no access to the tree list"));
  };
  const socket = yjsSocketOptions(session);
  const connection = connectTreeList({
    roomName: treeRoomName(list),
    ...socket,
    copy,
    onState,
    onRejected: (records) => rejected.push(...records),
  });
  return {
    copy,
    rejected,
    synced: outcome.then((result) => {
      clearTimeout(timer);
      if (result instanceof CliError) throw result;
      return result;
    }),
    close() {
      clearTimeout(timer);
      connection.destroy();
    },
  };
}

export class TreeList {
  private constructor(
    private readonly session: Session,
    private readonly list: TreeListRef,
    private readonly main: Connection,
    private readonly readOnly: boolean,
    /** `user:<id>`: the only actor an admission accepts from this account. */
    readonly actor: string,
  ) {}

  static async open(session: Session, list: TreeListRef, actor: string): Promise<TreeList> {
    const main = connect(session, list);
    try {
      return new TreeList(session, list, main, (await main.synced) === "read-only", actor);
    } catch (error) {
      main.close();
      throw error;
    }
  }

  /** The list as the copy stands, records appended a moment ago included. */
  replay(): TreeProjection {
    return replayView(this.main.copy.doc, LIVE);
  }

  /**
   * Makes records with the package's writer on the copy, then waits until the server holds them:
   * a second copy, synced after the append, must have each one and none refused. A refusal is the
   * server's whole answer for that record, with its reason.
   */
  async append(make: (writer: TreeWriter) => readonly TreeRecord[]): Promise<TreeRecord[]> {
    if (this.readOnly)
      throw new CliError("http_error", "This account may read the tree list, not write it");
    const records = [...make(new TreeWriter(this.main.copy.doc))];
    await this.admitted(records);
    return records;
  }

  private async admitted(records: readonly TreeRecord[]) {
    const check = connect(this.session, this.list);
    try {
      await check.synced;
      const deadline = Date.now() + ADMISSION_TIMEOUT_MS;
      for (;;) {
        const given = this.main.rejected.find((record) => records.some((r) => r.id === record.id));
        if (given) throw refusal(given, "the list kept refusing it");
        const settled = lastSettlements(check.copy.doc);
        const held = new Set(
          recordsOf(check.copy.doc)
            .toArray()
            .map((record) => record.id),
        );
        for (const record of records) {
          const answer = settled.get(record.id);
          if (answer?.to === "refused") throw refusal(record, answer.reason ?? "no reason given");
        }
        if (records.every((record) => held.has(record.id))) return;
        if (Date.now() > deadline)
          throw new CliError(
            "timeout",
            `The server had not admitted ${records.length} record(s) after ${ADMISSION_TIMEOUT_MS}ms`,
            { hint: "The records were sent; re-read the tree before repeating the command." },
          );
        await new Promise((done) => setTimeout(done, POLL_MS));
      }
    } finally {
      check.close();
    }
  }

  close() {
    this.main.close();
  }
}

function refusal(record: TreeRecord, reason: string): CliError {
  const name = (record as CreateRecord).name;
  return new CliError(
    "http_error",
    `The server refused the ${record.type}${name ? ` of ${name}` : ""}: ${reason}`,
  );
}
