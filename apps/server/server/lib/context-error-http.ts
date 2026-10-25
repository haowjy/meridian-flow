/** Canonical translation from context-domain failures to HTTP errors. */

import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { ContextError } from "../domains/context/index.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";

export function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "operation_mismatch":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "operation_mismatch",
          "Operation ID already names a different command",
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
        {
          ...meridianErrorFromSystem("conflict", "Context path conflict", false),
          details: error.occupantKind ? { occupantKind: error.occupantKind } : {},
        },
        409,
      );
    case "stale_source":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "stale_source",
          "Context location changed; retry the operation",
          true,
        ),
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
    case "invalid_operation":
      return throwHttpInterrupt(
        meridianErrorFromSystem(error.code, error.message ?? "Invalid context operation", false),
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
      return throwHttpInterrupt(meridianErrorFromSystem("io_error", error.message, true), 502);
  }
}

/** Locator resolution cannot distinguish a deleted Work from an unknown ID. */
export function throwContextWorkUnavailableHttpError(
  reason: Extract<ContextError, { code: "context_unavailable" }>["reason"],
): never {
  return throwHttpInterrupt(
    meridianErrorFromSystem(
      reason,
      reason === "work_archived" ? "This Work is archived and read-only." : "Work not found.",
      false,
    ),
    reason === "work_archived" ? 403 : 404,
  );
}
