import type { ReturnedWhy } from "@meridian/contracts/commands";
import type { DocumentRemovalRecord, PermissionDeniedReason } from "@meridian/contracts/protocol";
import { splitHashline } from "../model/hashline.js";
import { type DocumentCommandName, writeCommandName } from "./command-schema.js";

export const AGENT_EDIT_RESULT_SCHEMA = "meridian.agent-edit.v1" as const;

export type AgentEditResultCommand = DocumentCommandName | "unknown";

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "work_archived"
  | "binary_file"
  | "permission_denied"
  | "internal_error";

export type UndoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "expired"
  | "cant_undo_applied"
  | "cant_undo_discarded"
  | "cant_undo_changed"
  | "purged"
  | "insufficient_undo"
  | "nothing_to_revert";

export type WriteStatus = "success" | "returned" | WriteErrorStatus | UndoOutcome;

export interface AgentEditBlockItem {
  hash: string;
  body: string;
  gapLine?: string;
  section?: string;
}

export type AgentEditBlockGroup =
  | {
      extent: "full";
      relation: "document" | "changed";
      items: AgentEditBlockItem[];
    }
  | {
      extent: "prefix";
      relation: "context" | "copied";
      items: AgentEditBlockItem[];
    };

export interface AgentEditConcurrentGroup {
  author: string;
  changed?: string[];
  removed?: string[];
  overwritten?: string[];
}

export interface AgentEditConcurrentListing {
  groups: AgentEditConcurrentGroup[];
}

export interface AgentEditModelPayload {
  path?: string;
  destination?: "live" | "draft";
  draftWork?: string;
  message?: string;
  notice?: string;
  owner?: string;
  returned?: { why: ReturnedWhy; removal?: DocumentRemovalRecord };
  reason?: PermissionDeniedReason;
  write?: {
    id?: string;
    deletedHashes?: string[];
  };
  copied?: {
    from: string;
    blocks?: number;
  };
  tree?: AgentEditTreeFacts;
  file?: {
    documentId: string;
    uri: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    pageCount?: number;
    given: "media" | "text" | "description";
  };
  read?: {
    format: "full" | "outline" | "edits" | "changes";
    documentBlocks?: number;
    version?: "draft" | "live";
    draftWork?: string;
  };
  blocks?: AgentEditBlockGroup[];
  concurrent?: AgentEditConcurrentListing;
  awarenessDegraded?: boolean;
  documentEmpty?: boolean;
  unchanged?: boolean;
}

export interface AgentEditTreeFacts {
  moved?: { made: number; of: number };
  notMoved?: string[];
  copied?: Array<{ from: string; to: string }>;
  deleted?: number;
  kept?: string;
  placedAtEnd?: string;
  already?: "deleted" | "at_destination" | "live";
  leftOut?: Array<{ path: string; why: "would_loop" | "purged" }>;
  firstDrafted?: true;
  concurrent?: Array<{ author: string; lines: string[] }>;
}

interface AgentEditResultBase extends AgentEditModelPayload {
  schema: typeof AGENT_EDIT_RESULT_SCHEMA;
  command: AgentEditResultCommand;
}

export type AgentEditResultV1 = AgentEditResultBase & { status: WriteStatus };

type ModelResultInput = {
  command: AgentEditResultCommand;
  payload?: AgentEditModelPayload;
  status: WriteStatus;
};

export function modelResult(input: ModelResultInput): AgentEditResultV1 {
  return {
    ...input.payload,
    schema: AGENT_EDIT_RESULT_SCHEMA,
    command: input.command,
    status: input.status,
  };
}

export function agentEditResultCommand(input: unknown): AgentEditResultCommand {
  return writeCommandName(input) ?? "unknown";
}

type AgentEditResultEnvelope = Record<string, unknown> & {
  schema: typeof AGENT_EDIT_RESULT_SCHEMA;
  command: AgentEditResultCommand;
  status: WriteStatus;
};

export function isAgentEditResultEnvelope(input: unknown): input is AgentEditResultEnvelope {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const result = input as Record<string, unknown>;
  return (
    result.schema === AGENT_EDIT_RESULT_SCHEMA &&
    (result.command === "unknown" ||
      result.command === "read" ||
      writeCommandName(result) !== undefined) &&
    isWriteStatus(result.status)
  );
}

function isWriteStatus(status: unknown): status is WriteStatus {
  switch (status) {
    case "success":
    case "returned":
    case "not_found":
    case "ambiguous_match":
    case "invalid_write":
    case "document_not_found":
    case "partial_failure":
    case "work_archived":
    case "binary_file":
    case "internal_error":
    case "reversed":
    case "cant_undo_applied":
    case "cant_undo_discarded":
    case "cant_undo_changed":
    case "purged":
    case "insufficient_undo":
    case "nothing_to_revert":
    case "reconciled":
    case "partial":
    case "nothing_to_undo":
    case "expired":
      return true;
    default:
      return false;
  }
}

export function modelBlockItem(serialized: string): AgentEditBlockItem {
  const line = splitHashline(serialized);
  if (!line) return { hash: "", body: serialized };
  return {
    hash: line.hash,
    body: line.body.startsWith("\n") ? line.body.slice(1) : line.body,
  };
}
