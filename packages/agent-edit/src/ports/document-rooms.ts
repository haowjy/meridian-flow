import type { DocumentRemovalRecord, DocumentRoom } from "@meridian/contracts/protocol";
import type { RoomDocs, StoredEdit } from "@meridian/document-model";
import type { DocumentRooms, RoomOrigin } from "@meridian/document-model/rooms";
import type { PMNode } from "@meridian/markup";
import type { StoredDelta } from "../content-merge/delta.js";
import type { MutationActor, ReadCommand, WriteStatus } from "../tool/types.js";
import type { DocumentEditRequest, ModelInverseCommand } from "./document-edits.js";

export class DocumentNotFoundError extends Error {
  readonly docId: string;
  readonly removal?: DocumentRemovalRecord;

  constructor(
    docId: string,
    message = `Document not found: ${docId}`,
    options: { removal?: DocumentRemovalRecord } = {},
  ) {
    super(message);
    this.name = "DocumentNotFoundError";
    this.docId = docId;
    if (options.removal) this.removal = options.removal;
  }
}

export function isDocumentNotFoundError(cause: unknown): cause is DocumentNotFoundError {
  return cause instanceof DocumentNotFoundError;
}

export interface AgentRoomRead {
  room: DocumentRoom;
  docs: RoomDocs;
}

export interface AgentWriteRecord {
  documentId: string;
  room: DocumentRoom;
  edit: StoredEdit;
  writeId: string;
  wId: number;
  toolCallId?: string;
  threadId: string;
  turnId: string | null;
  authoringResponseId?: string;
  actor: MutationActor;
  delta: StoredDelta | null;
}

export interface AgentEditRooms {
  readRoom(documentId: string): Promise<AgentRoomRead>;

  /**
   * Store one write's batch, and its record, in the host's command: its docs' snapshots and the
   * record in the command's transaction, the import into the room after it commits.
   */
  save(room: DocumentRoom, batch: Uint8Array, record: AgentWriteRecord | null): Promise<void>;
}

export interface AgentEditRoomsHost<Tx> {
  roomFor(documentId: string): Promise<DocumentRoom>;
  transaction(): Tx;
  origin: RoomOrigin;
  recordWrite(tx: Tx, record: AgentWriteRecord, batch: Uint8Array): Promise<void>;
}

export function agentEditRooms<Tx>(
  rooms: DocumentRooms<Tx>,
  host: AgentEditRoomsHost<Tx>,
): AgentEditRooms {
  return {
    async readRoom(documentId) {
      const room = await host.roomFor(documentId);
      return { room, docs: await rooms.read(room) };
    },
    async save(room, batch, record) {
      const tx = host.transaction();
      await rooms.commit(tx, room, batch, host.origin);
      if (record) await host.recordWrite(tx, record, batch);
    },
  };
}

export interface DocumentCut {
  version: Uint8Array;
  blocks: readonly PMNode[];
}

export interface LoroDocumentEdits {
  read(request: DocumentEditRequest & { command: ReadCommand }): Promise<{
    status: "success" | Exclude<WriteStatus, "success">;
    message: string;
  }>;
  execute(request: DocumentEditRequest & { command: ModelInverseCommand }): Promise<
    | { status: Exclude<WriteStatus, "success">; message: string }
    | {
        status: "success";
        message: string;
        writeId?: string;
        updates?: readonly Uint8Array[];
      }
  >;
}
