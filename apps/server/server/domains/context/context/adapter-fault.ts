/** Canonical lifting of scheme-adapter faults into URI-scoped context errors. */
import type { AdapterFault } from "../ports/context-adapter.js";
import type { ContextError } from "../ports/context-port.js";

export function adapterFaultToContextError(fault: AdapterFault, uri: string): ContextError {
  switch (fault.code) {
    case "permission_denied":
      return { code: "permission_denied", uri };
    case "conflict":
      return { code: "conflict", uri };
    case "stale_source":
      return { code: "stale_source", uri };
    case "stale_target":
      return { code: "stale_target", uri };
    case "invalid_operation":
      return { code: "invalid_operation", uri, message: fault.message };
    case "context_unavailable":
      return { code: "context_unavailable", uri };
    case "io_error":
      return { code: "io_error", uri, message: fault.message };
  }
}
