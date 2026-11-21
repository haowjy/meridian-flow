// Versioned JSON result contract presented to editing models.
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

/**
 * What an undo or revert came to: it changed what it could and says what it left and why
 * (the writer applied it, discarded it, or changed the text since). None of these is an error:
 * the call settled.
 */
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

// Keep in sync with @meridian/contracts/protocol WriteStatus; agent-edit must stay host-agnostic.
export type WriteStatus = "success" | "returned" | WriteErrorStatus | UndoOutcome;
export type WriteSuccessPhase = "committed";

export interface AgentEditBlockItem {
  hash: string;
  body: string;
  /**
   * A read only: the line between this block and the one before it, when the document has one
   * (empty for a blank line, `>` inside a quote). Absent when the two lines are adjacent.
   */
  gapLine?: string;
  /** Outline headings only: the `#heading-slug` that reads this heading's section. */
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
      /** `copied`: the first and last block a block copy wrote, by their opening words. */
      relation: "context" | "copied";
      items: AgentEditBlockItem[];
    };

/** What one author changed since the model's prior frontier, by block hash. */
export interface AgentEditConcurrentGroup {
  /** `the user` for any person, `agent (<chat ref>)` for a traced chat. */
  author: string;
  /** Changed blocks the result's echo renders, after the merge. */
  shown?: string[];
  /** Changed blocks the result does not render. */
  other?: string[];
  removed?: string[];
  /** Blocks this author changed that the write then removed (deleted or joined). */
  overwritten?: string[];
}

export interface AgentEditConcurrentListing {
  groups: AgentEditConcurrentGroup[];
}

export interface AgentEditModelPayload {
  /** The document path the command read or changed, as the caller named it. */
  path?: string;
  /** Where a write landed: the live document, or the document's draft in the Work named by `draftWork`. */
  destination?: "live" | "draft";
  /** The drafted Work's handle, `/` for No Work; present only when `destination` is `draft`. */
  draftWork?: string;
  message?: string;
  /** A line the host puts first when the address named an owner the caller may not have meant. */
  notice?: string;
  /** The owner a named address reaches (`Work "Tea Arc"`), which the receipt puts after the path. */
  owner?: string;
  /**
   * A `returned` write: it did not land, and the document is shown as it stands. `why` is the
   * part of it the writer changed; `removal` says who removed the document, when it was.
   */
  returned?: { why: ReturnedWhy; removal?: DocumentRemovalRecord };
  /** Why a `permission_denied` result was refused (file-access §9). */
  reason?: PermissionDeniedReason;
  write?: {
    id?: string;
    deletedHashes?: string[];
  };
  /**
   * A copy's receipt: the source as the model named it and how many blocks the
   * copy wrote. A binary file's copy has no blocks.
   */
  copied?: {
    from: string;
    blocks?: number;
  };
  /** What a tree command did beyond landing its node: each fact differs from what the call said. */
  tree?: AgentEditTreeFacts;
  /**
   * A read of a file that is not a tracked document: which file it was and what the model was
   * given of it (`media` to look at, `text` extracted from it, or only a `description`).
   */
  file?: {
    documentId: string;
    uri: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    /** A PDF's page count, set when it is given as media. */
    pageCount?: number;
    given: "media" | "text" | "description";
  };
  read?: {
    format: "full" | "outline" | "edits";
    /** The whole document's block count; the text names it when the read returned fewer. */
    documentBlocks?: number;
    /** The version actually read; the host fills it in, since only it knows the selected document draft. */
    version?: "draft" | "live";
    /** The Work a `draft` read names, as a write's `draftWork` does; `/` for no Work's draft. */
    draftWork?: string;
  };
  blocks?: AgentEditBlockGroup[];
  concurrent?: AgentEditConcurrentListing;
  awarenessDegraded?: boolean;
  /** The write left the document empty; its one blank block is the empty document, not a leftover. */
  documentEmpty?: boolean;
  /** The document already matched the write, so nothing was recorded and no write id exists. */
  unchanged?: boolean;
}

/** What a tree command's result states about the tree, and nothing about the parts it did not touch. */
export interface AgentEditTreeFacts {
  /** Several moved into one folder: how many landed, of how many asked. */
  moved?: { made: number; of: number };
  /** Each one not made, with its reason. */
  notMoved?: string[];
  /**
   * A move's sources in another list (a project's files and `user://` are two): each was copied
   * to `to`, and the original stays at `from`.
   */
  copied?: Array<{ from: string; to: string }>;
  /** A folder's delete took this many documents and files. */
  deleted?: number;
  /** A folder stands holding what was not deleted, or what a restore needed. */
  kept?: string;
  placedAtEnd?: string;
  /** The call's end was already true, so nothing was made. */
  already?: "deleted" | "at_destination" | "live";
  /** Nodes the call left alone, each with the one reason. */
  leftOut?: Array<{ path: string; why: "would_loop" | "purged" }>;
  /** The first drafted tree change of a reply says once that drafted changes wait for review. */
  firstDrafted?: true;
  /** What others did to the nodes the call named, by author. */
  concurrent?: Array<{ author: string; lines: string[] }>;
}

interface AgentEditResultBase extends AgentEditModelPayload {
  schema: typeof AGENT_EDIT_RESULT_SCHEMA;
  command: AgentEditResultCommand;
}

export type AgentEditResultV1 = AgentEditResultBase &
  (
    | { status: "success"; phase: WriteSuccessPhase }
    | { status: Exclude<WriteStatus, "success">; phase?: never }
  );

type ModelResultInput = {
  command: AgentEditResultCommand;
  payload?: AgentEditModelPayload;
} & (
  | { status: "success"; phase: WriteSuccessPhase }
  | { status: Exclude<WriteStatus, "success">; phase?: never }
);

export function modelResult(input: ModelResultInput): AgentEditResultV1 {
  const base = {
    ...input.payload,
    schema: AGENT_EDIT_RESULT_SCHEMA,
    command: input.command,
  };
  if (input.status === "success") {
    return { ...base, status: "success", phase: input.phase };
  }
  return { ...base, status: input.status };
}

/** The result command for a `write` call's arguments, which may be malformed. */
export function agentEditResultCommand(input: unknown): AgentEditResultCommand {
  return writeCommandName(input) ?? "unknown";
}

type AgentEditResultEnvelope = Record<string, unknown> & {
  schema: typeof AGENT_EDIT_RESULT_SCHEMA;
  command: AgentEditResultCommand;
  status: WriteStatus;
  phase?: WriteSuccessPhase;
};

/**
 * Validates only the durable envelope fields used by recovery.
 *
 * Payload fields remain opaque because recovery preserves them rather than
 * interpreting them. Naming this as an envelope check keeps the type guard
 * honest instead of claiming arbitrary persisted JSON is a full model result.
 */
export function isAgentEditResultEnvelope(input: unknown): input is AgentEditResultEnvelope {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const result = input as Record<string, unknown>;
  if (
    result.schema !== AGENT_EDIT_RESULT_SCHEMA ||
    (result.command !== "unknown" &&
      result.command !== "read" &&
      writeCommandName(result) === undefined) ||
    !isWriteStatus(result.status)
  ) {
    return false;
  }
  if (result.status === "success") {
    return result.phase === "committed";
  }
  return result.phase === undefined;
}

export function isWriteStatus(status: unknown): status is WriteStatus {
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
