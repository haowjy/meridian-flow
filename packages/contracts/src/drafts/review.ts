import type { Settlement } from "../commands/index.js";
import type { ParsedContextUri } from "../context-uri.js";
import type { DraftId, DraftItemKey, ProjectId, ThreadId, UserId } from "../ids.js";
import type { ContextOperationReceipt } from "../protocol/context-operation.js";
import type { ReversalOutcome } from "../protocol/write-reversal.js";
import type { JsonObject, JsonValue, ToolContentPart } from "../threads/index.js";

export type TreeSaw = {
  project?: { list: string; vector: string };
  account?: { list: string; vector: string };
};

export type StoredDocumentCommandResult =
  | ModelEditCommandResult
  | ReverseTurnCommandResult
  | CopyCommandResult
  | import("./press.js").PressResult
  | import("./press.js").PressUndoResult;

export type ReverseTurnCommandResult = {
  status: "reversed";
  outcome: ReversalOutcome;
};

export type CopyCommandResult = {
  status: "copied";
  receipt: ContextOperationReceipt;
  settled?: Settlement[];
};

export type ModelEditToolResult = {
  toolCallId: string;
  content: ToolContentPart[];
  result: JsonValue;
  isError?: boolean;
  metadata?: JsonObject;
};

export type ModelEditKey = {
  threadId: ThreadId;
  responseId: string;
  toolCallId: string;
  accountId: UserId;
  projectId: ProjectId;
};

export type ModelEditCommandResult = {
  status: "edited" | "returned" | "refused";
  toolResult: ModelEditToolResult;
  settled?: Settlement[];
};

export interface DraftItem {
  draftId: DraftId;
  itemKey: DraftItemKey;
  documentId: string;
  pending: boolean;
  liveVersion: string | null;
  changeCount: number;
  origin: "created" | "edited";
  isNew: boolean;
  binary: boolean;
  wholeItem: boolean;
  documentName: string | null;
  contextLocation: Pick<ParsedContextUri, "scheme" | "path"> | null;
  tree: {
    movedFrom?: Pick<ParsedContextUri, "scheme" | "path">;
    deleted?: true;
  } | null;
  actorThreads: { threadId: string; title: string | null }[];
  unattributed: boolean;
  updatedAt: string;
}

export interface DocumentDraftHint {
  draftId: DraftId;
  itemKey: DraftItemKey;
  label: string | null;
  tree: { movedTo: Pick<ParsedContextUri, "scheme" | "path"> } | { deleted: true } | null;
}

export interface DocumentDraftHintsResponse {
  items: DocumentDraftHint[];
}

export interface DraftItemsResponse {
  items: DraftItem[];
  folders: { id: string }[];
  saw: TreeSaw;
}

export type ModelEditOutcome =
  | { status: "done" | "refused"; result: ModelEditCommandResult }
  | { status: "never" };
