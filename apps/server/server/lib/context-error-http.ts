import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { ContextError } from "../domains/context/index.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";

export function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "command_conflict":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "command_conflict",
          "Command ID already names a different command",
          false,
        ),
        409,
      );
    case "invalid_uri":
      return throwHttpInterrupt(meridianErrorFromSystem("invalid_uri", error.reason, false), 400);
    case "permission_denied":
      return throwHttpInterrupt(
        meridianErrorFromSystem("permission_denied", "Context access denied", false),
        403,
      );
    case "conflict":
      return throwHttpInterrupt(
        meridianErrorFromSystem("conflict", "Context path conflict", false),
        409,
      );
    case "destination_missing":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "destination_missing",
          "The destination folder is no longer available.",
          false,
        ),
        409,
      );
    case "stale_target":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "stale_target",
          "The context entry changed. Refresh and try again.",
          true,
        ),
        409,
      );
    case "invalid_name":
      return throwHttpInterrupt(meridianErrorFromSystem(error.code, error.message, false), 400);
    case "invalid_operation":
      return throwHttpInterrupt(
        {
          ...meridianErrorFromSystem(
            error.code,
            error.message ?? "Invalid context operation",
            false,
          ),
          ...(error.reason ? { details: { reason: error.reason } } : {}),
        },
        400,
      );
    case "not_found":
      return throwHttpInterrupt(
        meridianErrorFromSystem("not_found", "Context path not found", false),
        404,
      );
    case "context_unavailable":
      return throwContextWorkUnavailableHttpError(error.reason);
    case "io_error":
      return throwHttpInterrupt(
        {
          ...meridianErrorFromSystem("io_error", error.message, true),
          ...(error.reason ? { details: { reason: error.reason } } : {}),
        },
        error.reason === "source_behind" ? 503 : 502,
      );
  }
}

const WORK_UNAVAILABLE = {
  work_archived: { message: "This Work is archived and read-only.", status: 403 },
  work_deleted: { message: "This Work was deleted.", status: 404 },
  work_missing: { message: "Work not found.", status: 404 },
} as const;

export function throwContextWorkUnavailableHttpError(
  reason: Extract<ContextError, { code: "context_unavailable" }>["reason"],
): never {
  const { message, status } = WORK_UNAVAILABLE[reason];
  return throwHttpInterrupt(meridianErrorFromSystem(reason, message, false), status);
}
