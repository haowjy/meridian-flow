/** Durable namespace attempt outcomes, independent from current canonical location. */
import type { OwnerSlip } from "../context-uri.js";
import type {
  CopyContextEntriesResult,
  CopyContextEntrySource,
  DeleteContextEntryRequest,
  DeleteContextEntryResult,
  MoveContextEntryRequest,
} from "./http-types.js";

/**
 * Why an operation can't run, when a caller words it: a path two nodes share, or a rename
 * whose extension would change how the document is stored (a binary file to a text one or
 * back), or which kind of text document it is.
 */
export type InvalidOperationReason =
  | "ambiguous_path"
  | "file_type_conversion"
  | "document_type_conversion";

export type ContextError =
  | { code: "operation_mismatch"; uri: string }
  | { code: "invalid_name"; uri: string; message: string }
  | { code: "not_found"; uri: string }
  | { code: "destination_missing"; uri: string }
  | { code: "permission_denied"; uri: string }
  | { code: "conflict"; uri: string; occupantKind?: "file" | "folder" }
  | { code: "stale_source"; uri: string }
  | { code: "stale_target"; uri: string }
  | { code: "invalid_operation"; uri: string; message?: string; reason?: InvalidOperationReason }
  | {
      code: "context_unavailable";
      uri: string;
      reason: "work_archived" | "work_deleted" | "work_missing";
      workHandle: string | null;
    }
  | {
      code: "invalid_uri";
      uri: string;
      reason: string;
      workHandle?: string;
      unknownScheme?: string;
      slip?: OwnerSlip;
    }
  | {
      code: "io_error";
      uri: string;
      message: string;
      /**
       * `source_behind`: a Copy's source room has not received the edits the writer's client
       * holds. Retryable like any `io_error`, and told apart so a replica bounds its retries.
       */
      reason?: "source_behind";
    };

export interface ContextMoveResult {
  movedNodeId?: string;
  linkUpdate?: { links: number; documents: number };
  /** Scheme-relative path durably committed by the tree mutation. */
  destinationPath: string;
  destinationUri?: string;
  /** Per-entry namespace mutation revision produced by this exact operation. */
  locationVersion?: string;
}

export type ContextOperationCommand =
  | {
      kind: "move";
      sourceUri: string;
      destinationUri: string;
      expected: MoveContextEntryRequest["expected"];
      destinationParent?: MoveContextEntryRequest["destinationParent"];
      position?: MoveContextEntryRequest["position"];
    }
  | { kind: "delete"; uri: string; expected: DeleteContextEntryRequest["expected"] }
  | {
      kind: "copy";
      /** Ordered roots by canonical address; the read view travels with each. */
      sources: CopyContextEntryCommandSource[];
      destinationUri: string;
      destinationParent?: MoveContextEntryRequest["destinationParent"];
      position?: MoveContextEntryRequest["position"];
    };

/**
 * One root as the receipt remembers it. The client's state vector is deliberately absent:
 * a replay after more typing carries a newer vector, and that is the same Copy.
 */
export type CopyContextEntryCommandSource = Pick<CopyContextEntrySource, "view"> & {
  uri: string;
  expected: CopyContextEntrySource["expected"];
};

export type ContextOperationValue = {
  move: ContextMoveResult;
  delete: DeleteContextEntryResult;
  copy: CopyContextEntriesResult;
};

export type ContextOperationResult<K extends ContextOperationCommand["kind"]> =
  | { ok: true; value: ContextOperationValue[K] }
  | { ok: false; error: ContextError };

export type ContextOperationReceipt = {
  [K in ContextOperationCommand["kind"]]: {
    operationId: string;
    /** Server namespace watermark captured with this immutable command outcome. */
    observationVersion: string;
    command: Extract<ContextOperationCommand, { kind: K }>;
    result: ContextOperationResult<K>;
  };
}[ContextOperationCommand["kind"]];
