import { loroRoomName, type TreeListRef } from "@meridian/contracts/protocol";
import {
  type DocVersion,
  decodeEnvelope,
  decodeRoomVersion,
  docCovers,
  docVersion,
  encodeEnvelope,
  freshPeerId,
  withVector,
} from "@meridian/document-model";
import {
  type CreateRecord,
  draftRows,
  LIVE,
  lastSettlements,
  listRecords,
  pendingRecords,
  projectedRows,
  replayView,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
  type View,
} from "@meridian/project-tree";
import { LoroDoc } from "loro-crdt";
import { CliError } from "../../core/cli-error";
import { LoroSocket } from "../../core/loro-socket";
import type { Session } from "../../core/session";

const SYNC_TIMEOUT_MS = 15_000;

const LIST_DOC = "s";

type Connection = { doc: LoroDoc; socket: LoroSocket; room: string; sent: DocVersion };

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
    while (served && !docCovers(docVersion(doc), served)) {
      if (Date.now() > deadline)
        throw new CliError(
          "unavailable",
          `The project's tree list did not sync in ${SYNC_TIMEOUT_MS}ms`,
        );
      await new Promise((done) => setTimeout(done, 20));
    }
    return { doc, socket, room, sent: docVersion(doc) };
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
    readonly actor: string,
  ) {}

  static async open(session: Session, list: TreeListRef, actor: string): Promise<TreeList> {
    return new TreeList(session, list, await connect(session, list), actor);
  }

  replay(view: View = LIVE): TreeProjection {
    return replayView(this.main.doc, view);
  }

  onlyInDraft(node: string, draft: string): boolean {
    const rows = draftRows(
      projectedRows(this.replay()),
      projectedRows(this.replay({ draft })),
      pendingRecords(this.main.doc, draft),
    );
    return rows.get(node)?.existsOnlyInDraft === true;
  }

  async append(make: (writer: TreeWriter) => readonly TreeRecord[]): Promise<TreeRecord[]> {
    const { main } = this;
    const records = [...make(new TreeWriter(main.doc))];
    const update = withVector(main.sent, (from) => main.doc.export({ mode: "update", from }));
    main.sent = docVersion(main.doc);
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
