// Host-owned immutable edit history and forward inverses; no reconstruction journal.
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
      /** The draft the command ran on, null for the live document: an inverse's `after` is its cut. */
      draftId: string | null;
      before?: Uint8Array;
      after?: Uint8Array;
    };
export interface DocumentEdits {
  execute(
    request: DocumentEditRequest & { command: ModelInverseCommand },
  ): Promise<DocumentEditResult>;
  read(request: DocumentEditRequest & { command: ReadCommand }): Promise<DocumentEditResult>;
}
