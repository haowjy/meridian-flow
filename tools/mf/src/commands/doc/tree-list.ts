/**
 * `./mf` as a tree-list client: the project's list opened through the same package the browser
 * uses, records made with the package's writer, and the server's admission read back from a second
 * copy of the list. There is no route for a tree change: the list is the write path.
 */
import { loroRoomName, type TreeListRef } from "@meridian/contracts/protocol";
import {
  decodeEnvelope,
  decodeRoomVersion,
  encodeEnvelope,
  freshPeerId,
} from "@meridian/document-model";
import {
  type CreateRecord,
  LIVE,
  lastSettlements,
  listRecords,
  replayView,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
} from "@meridian/project-tree";
import { LoroDoc, type VersionVector } from "loro-crdt";
import { CliError } from "../../core/cli-error";
import { LoroSocket } from "../../core/loro-socket";
import type { Session } from "../../core/session";

const SYNC_TIMEOUT_MS = 15_000;

/** The list's one doc in its room's envelope. */
const LIST_DOC = "s";

type Connection = { doc: LoroDoc; socket: LoroSocket; room: string; sent: VersionVector };

/** A fresh copy of the list, joined to its room and holding everything the server stores. */
async function connect(session: Session, list: TreeListRef): Promise<Connection> {
  const socket = await LoroSocket.open(session);
  const doc = new LoroDoc();
  const peer = freshPeerId();
  doc.setPeerId(peer);
  const room = loroRoomName({ kind: "tree", list });
  try {
    const answer = await socket.join(room, {
      peer,
      version: new Uint8Array(),
      onBatch: (envelope) => {
        const update = decodeEnvelope(envelope).get(LIST_DOC);
        if (update) doc.import(update);
      },
    });
    const served = decodeRoomVersion(answer.version).get(LIST_DOC);
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    while (served && doc.oplogVersion().compare(served) === -1) {
      if (Date.now() > deadline)
        throw new CliError(
          "unavailable",
          `The project's tree list did not sync in ${SYNC_TIMEOUT_MS}ms`,
        );
      await new Promise((done) => setTimeout(done, 20));
    }
    return { doc, socket, room, sent: doc.oplogVersion() };
  } catch (error) {
    socket.close();
    doc.free();
    throw error;
  }
}

function close(connection: Connection) {
  connection.socket.close();
  connection.doc.free();
}

export class TreeList {
  private constructor(
    private readonly session: Session,
    private readonly list: TreeListRef,
    private readonly main: Connection,
    /** `user:<id>`: the only actor an admission accepts from this account. */
    readonly actor: string,
  ) {}

  static async open(session: Session, list: TreeListRef, actor: string): Promise<TreeList> {
    return new TreeList(session, list, await connect(session, list), actor);
  }

  /** The list as the copy stands, records appended a moment ago included. */
  replay(): TreeProjection {
    return replayView(this.main.doc, LIVE);
  }

  /**
   * Makes records with the package's writer on the copy, sends them, and once the room has
   * acknowledged them reads the list again from a second copy: the server stores a client's
   * records and its stamps on them in one transaction, so that copy has each record, and a
   * `dropped` stamp is the server's whole answer for a record, with its reason.
   */
  async append(
    make: (writer: TreeWriter<LoroDoc>) => readonly TreeRecord[],
  ): Promise<TreeRecord[]> {
    const { main } = this;
    const records = [...make(new TreeWriter(main.doc))];
    const update = main.doc.export({ mode: "update", from: main.sent });
    main.sent = main.doc.oplogVersion();
    await main.socket.send(main.room, encodeEnvelope(new Map([[LIST_DOC, update]])));
    const check = await connect(this.session, this.list);
    try {
      const settled = lastSettlements(check.doc);
      const held = new Set(listRecords(check.doc).map((record) => record.id));
      for (const record of records) {
        const answer = settled.get(record.id);
        if (answer?.to === "dropped") throw refusal(record, answer.reason ?? "no reason given");
        if (!held.has(record.id)) throw refusal(record, "the server does not hold it");
      }
    } finally {
      close(check);
    }
    return records;
  }

  close() {
    close(this.main);
  }
}

function refusal(record: TreeRecord, reason: string): CliError {
  const name = (record as CreateRecord).name;
  return new CliError(
    "http_error",
    `The server refused the ${record.type}${name ? ` of ${name}` : ""}: ${reason}`,
  );
}
