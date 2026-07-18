/** Canonical translation from context-domain failures to HTTP errors. */

import { createError } from "nitro/h3";
import type { ContextError } from "../domains/context/index.js";

export function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "invalid_uri":
      throw createError({ statusCode: 400, message: error.reason });
    case "permission_denied":
      throw createError({ statusCode: 403, message: "Context access denied" });
    case "conflict":
      throw createError({ statusCode: 409, message: "Context path conflict" });
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
