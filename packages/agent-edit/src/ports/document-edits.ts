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
      actionId: string;
      writeId?: string;
      room: string | null;
      before?: Uint8Array;
      after?: Uint8Array;
      updates?: readonly Uint8Array[];
      destination?: "live" | "draft";
      draftWork?: string;
    };
export interface DocumentEdits {
  execute(
    request: DocumentEditRequest & { command: ModelInverseCommand },
  ): Promise<DocumentEditResult>;
  read(request: DocumentEditRequest & { command: ReadCommand }): Promise<DocumentEditResult>;
}
