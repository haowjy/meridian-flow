/** Canonical translation from context-domain failures to HTTP errors. */

import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { ContextError } from "../domains/context/index.js";
import { throwHttpInterrupt } from "./interrupt-boundary.js";

export function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "invalid_uri":
      throw createError({ statusCode: 400, message: error.reason });
    case "permission_denied":
      throw createError({ statusCode: 403, message: "Context access denied" });
    case "conflict":
      throw createError({ statusCode: 409, message: "Context path conflict" });
    case "stale_source":
      throw createError({
        statusCode: 409,
        message: "Context location changed; retry the operation",
      });
    case "stale_target":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          "stale_target",
          "The context entry changed. Refresh and try again.",
          true,
        ),
        409,
      );
    case "invalid_operation":
      throw createError({ statusCode: 400, message: error.message ?? "Invalid context operation" });
    case "not_found":
      throw createError({ statusCode: 404, message: "Context path not found" });
    case "context_unavailable":
      throw createError({ statusCode: 503, message: "Context is unavailable" });
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
  }
}
