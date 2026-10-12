/** Canonical translation from context-domain failures to HTTP errors. */

import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { ContextError } from "../domains/context/index.js";
import { throwHttpInterrupt } from "./interrupt-boundary.js";

export function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "operation_mismatch":
      throw createError({
        statusCode: 409,
        message: "Operation ID already names a different command",
      });
    case "invalid_uri":
      throw createError({ statusCode: 400, message: error.reason });
    case "permission_denied":
      throw createError({ statusCode: 403, message: "Context access denied" });
    case "conflict":
      throw createError({
        statusCode: 409,
        message: "Context path conflict",
        data: { occupantKind: error.occupantKind },
      });
    case "stale_source":
      throw createError({
        statusCode: 409,
        message: "Context location changed; retry the operation",
      });
    case "destination_missing":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "destination_missing",
          "The destination folder is no longer available.",
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
      throw createError({ statusCode: 400, message: error.message ?? "Invalid context operation" });
    case "not_found":
      throw createError({ statusCode: 404, message: "Context path not found" });
    case "context_unavailable":
      return throwContextWorkUnavailableHttpError(error.reason);
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
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
    ),
    reason === "work_archived" ? 403 : 404,
  );
}
