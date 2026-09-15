/** Durable namespace attempt outcomes, independent from current canonical location. */
import type {
  DeleteContextEntryRequest,
  DeleteContextEntryResult,
  MoveContextEntryRequest,
} from "./http-types.js";

export type ContextError =
  | { code: "operation_mismatch"; uri: string }
  | { code: "not_found"; uri: string }
  | { code: "permission_denied"; uri: string }
  | { code: "conflict"; uri: string }
  | { code: "stale_source"; uri: string }
  | { code: "stale_target"; uri: string }
  | { code: "invalid_operation"; uri: string; message?: string }
  | { code: "context_unavailable"; uri: string }
  | {
      code: "invalid_uri";
      uri: string;
      reason: string;
      workSlug?: string;
      validWorkSlugs?: string[];
    }
  | { code: "io_error"; uri: string; message: string };

export interface ContextMoveResult {
  movedNodeId?: string;
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
