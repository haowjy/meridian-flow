// Host-owned immutable edit history and forward inverses; no reconstruction journal.

import type { BlockOriginMap } from "../model/block-hash.js";
import type { ReadCommand, WriteCommand, WriteContext, WriteStatus } from "../tool/types.js";

export type ModelInverseCommand = Extract<WriteCommand, { command: "undo" | "redo" | "revert" }>;
export interface DocumentEditRequest {
  documentId: string;
  threadId: string;
  context: WriteContext;
}
export type DocumentEditResult =
  | { status: Exclude<WriteStatus, "success">; message: string }
  | {
      status: "success";
      message: string;
      actionId: string;
      writeId?: string;
      /** The host's label for the room the command ran in: an inverse's `after` is its cut. */
      room: string | null;
      /** The text cuts around the inverse; both absent when it changed no text (a move's undo). */
      before?: Uint8Array;
      after?: Uint8Array;
      /** An inverse's committed bytes, exactly as journaled, in order: the reply replays them. */
      updates?: readonly Uint8Array[];
      /** The immutable address context for draft cuts returned as bytes. */
      blockOrigins?: BlockOriginMap;
    };
export interface DocumentEdits {
  execute(
    request: DocumentEditRequest & { command: ModelInverseCommand },
  ): Promise<DocumentEditResult>;
  read(request: DocumentEditRequest & { command: ReadCommand }): Promise<DocumentEditResult>;
}
