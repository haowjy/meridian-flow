/** Durable namespace attempt outcomes, independent from current canonical location. */
import type { FileAccessDenial } from "./file-access.js";
import type {
  DeleteContextEntryRequest,
  DeleteContextEntryResult,
  MoveContextEntryRequest,
} from "./http-types.js";

/** Expected namespace refusals, preserved for model and localized writer copy. */
export type NamespaceRefusalReason =
  | "location_taken"
  | "folder_missing"
  | "source_is_folder"
  | "destination_is_folder"
  | "path_required"
  | "file_type_conversion"
  | "document_type_conversion"
  | "stale_location"
  | "already_at_destination"
  | "already_reversed"
  | "document_missing"
  | "invalid_path"
  | "invalid_operation"
  | "request_failed"
  | "work_deleted"
  | "work_missing";

export type ContextError =
  | { code: "operation_mismatch"; uri: string }
  | { code: "not_found"; uri: string }
  | { code: "permission_denied"; uri: string; reason?: FileAccessDenial }
  | { code: "conflict"; uri: string }
  | { code: "stale_source"; uri: string }
  | { code: "stale_target"; uri: string }
  | { code: "invalid_operation"; uri: string; reason?: NamespaceRefusalReason; message?: string }
  | {
      code: "context_unavailable";
      uri: string;
      reason: "work_archived" | "work_deleted" | "work_missing";
      workSlug: string | null;
    }
  | {
      code: "invalid_uri";
      uri: string;
      reason: string;
      workSlug?: string;
      unknownScheme?: string;
    }
  | { code: "io_error"; uri: string; message: string };

export interface ContextMoveResult {
  movedNodeId?: string;
  linkUpdate?: { links: number; documents: number };
  /** Scheme-relative path durably committed by the tree mutation. */
  destinationPath: string;
}

export type ContextOperationCommand =
  | {
      kind: "move";
      sourceUri: string;
      destinationUri: string;
      expected: MoveContextEntryRequest["expected"];
    }
  | { kind: "delete"; uri: string; expected: DeleteContextEntryRequest["expected"] };

export type ContextOperationValue = {
  move: ContextMoveResult;
  delete: DeleteContextEntryResult;
};

export type ContextOperationResult<K extends ContextOperationCommand["kind"]> =
  | { ok: true; value: ContextOperationValue[K] }
  | { ok: false; error: ContextError };

export type ContextOperationReceipt = {
  [K in ContextOperationCommand["kind"]]: {
    operationId: string;
    command: Extract<ContextOperationCommand, { kind: K }>;
    result: ContextOperationResult<K>;
  };
}[ContextOperationCommand["kind"]];
