import type { ReadCommand, WriteCommand, WriteContext, WriteStatus } from "../tool/types.js";

export type ModelInverseCommand = Extract<WriteCommand, { command: "undo" | "revert" }>;

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
      writeId?: string;
      /** The batches an inverse committed: the reply's later writes plan on them. */
      updates?: readonly Uint8Array[];
    };

/**
 * The host's record of a document's AI edits and their inverses, answered with a message (the
 * model's `undo`/`revert` echo is its message).
 */
export interface DocumentEdits {
  /** The model's list of its edits (`read` with `format: "edits"`). */
  read(request: DocumentEditRequest & { command: ReadCommand }): Promise<DocumentEditResult>;
  /** The model's `undo` or `revert`: the host writes the inverse and says what it did. */
  execute(
    request: DocumentEditRequest & { command: ModelInverseCommand },
  ): Promise<DocumentEditResult>;
}
