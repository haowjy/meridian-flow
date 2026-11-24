import type { OwnerSlip } from "../context-uri.js";
import type {
  ContextDestinationParent,
  ContextSiblingPosition,
  CopyContextEntriesResult,
  CopyContextEntrySource,
  CopyContextEntryView,
} from "./http-types.js";

export type InvalidOperationReason = "file_type_conversion" | "document_type_conversion";

export type ContextError =
  | { code: "command_conflict"; uri: string }
  | { code: "invalid_name"; uri: string; message: string }
  | { code: "not_found"; uri: string }
  | { code: "destination_missing"; uri: string }
  | { code: "permission_denied"; uri: string }
  | { code: "conflict"; uri: string }
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
      reason?: "source_behind";
    };

export type ContextOperationCommand = {
  kind: "copy";
  sources: CopyContextEntryCommandSource[];
  destinationUri: string;
  destinationView?: CopyContextEntryView;
  destinationParent?: ContextDestinationParent;
  position?: ContextSiblingPosition;
};

export type CopyContextEntryCommandSource = Pick<CopyContextEntrySource, "view" | "copyId"> & {
  uri: string;
  expected: CopyContextEntrySource["expected"];
};

export type ContextOperationResult =
  | { ok: true; value: CopyContextEntriesResult }
  | { ok: false; error: ContextError };

export type ContextOperationReceipt = {
  operationId: string;
  command: ContextOperationCommand;
  result: ContextOperationResult;
};
