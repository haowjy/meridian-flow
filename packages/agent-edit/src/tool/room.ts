// The one door to a document: a call's private copy of its room, or the typed result when it can't be read.
import type * as Y from "yjs";
import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
} from "../ports/document-coordinator.js";
import { documentNotFound, type InternalWriteResult } from "./internal-result.js";
import type { DocumentCommandName } from "./types.js";

export interface RoomCallInput {
  docId: string;
  commandName: DocumentCommandName;
  /** The Work draft a draft call reads, as the host routed it; live when absent. */
  workDraftId?: string;
}

export interface RoomCopy {
  doc: Y.Doc;
  /** The room the copy was read from; null records no frontier. */
  room: string | null;
  /** Journal high-water mark for the committed part of this copy. */
  position?: number;
  dispose(): void;
}

export async function openRoom(
  coordinator: DocumentCoordinator,
  input: RoomCallInput,
): Promise<RoomCopy | InternalWriteResult> {
  try {
    const { doc, room, position } = await coordinator.readRoom(
      input.docId,
      input.workDraftId ? { workDraftId: input.workDraftId } : undefined,
    );
    return {
      doc,
      room,
      ...(position === undefined ? {} : { position }),
      dispose: () => doc.destroy(),
    };
  } catch (cause) {
    if (!isDocumentNotFoundError(cause)) throw cause;
    return documentNotFound(input.commandName, cause);
  }
}
