/**
 * Request-observability helpers: mint and read per-request correlation from
 * Nitro event context and build safe route-status diagnostics. Runtime turns
 * carry their own run ids; this covers the rest of the server stack.
 */
import type { EventRecord } from "../domains/observability/index.js";

export type RequestObservabilityEvent = {
  req: Request;
  context: Record<string, unknown> & {
    matchedRoute?: { route?: string };
    observability?: RequestObservabilityContext;
    observabilityUnexpectedRouteFailureEmitted?: boolean;
  };
};

export type RequestObservabilityContext = {
  traceId: string;
  requestId: string;
  method: string;
  route: string;
  startedAtMs: number;
};

export type RequestObservabilityResponse = {
  status?: number;
  statusText?: string;
};

function requestId(request: Request, fallback: string): string {
  const external = request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id");
  return external && /^[A-Za-z0-9._:-]{1,128}$/.test(external) ? external : fallback;
}

function routePath(event: RequestObservabilityEvent): string {
  if (event.context.matchedRoute?.route === "/**:unknown") return "/:unmatched";
  if (event.context.matchedRoute?.route) return event.context.matchedRoute.route;
  return "/:unmatched";
}

export function createRequestObservabilityContext(
  event: RequestObservabilityEvent,
): RequestObservabilityContext {
  const traceId = crypto.randomUUID();
  return {
    traceId,
    requestId: requestId(event.req, traceId),
    method: event.req.method,
    route: routePath(event),
    startedAtMs: Date.now(),
  };
}

export function getRequestObservabilityContext(
  event: RequestObservabilityEvent,
): RequestObservabilityContext | null {
  const context = event.context.observability;
  if (!context || typeof context !== "object") return null;
  context.route = routePath(event);
  return context;
}

export function markUnexpectedRouteFailureEmitted(event: RequestObservabilityEvent): void {
  event.context.observabilityUnexpectedRouteFailureEmitted = true;
}

export function unexpectedRouteFailureWasEmitted(event: RequestObservabilityEvent): boolean {
  return event.context.observabilityUnexpectedRouteFailureEmitted === true;
}

export function shouldEmitUnexpectedRouteFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    unhandled?: unknown;
  };
  const isHttpError =
    candidate.name === "HTTPError" ||
    typeof candidate.status === "number" ||
    typeof candidate.statusCode === "number";
  return !isHttpError || candidate.unhandled === true;
}

export function routeStatusEvent(
  context: RequestObservabilityContext,
  response: RequestObservabilityResponse,
  nowMs = Date.now(),
): EventRecord | null {
  const statusCode = response.status ?? 200;
  if (statusCode < 400) return null;
  return {
    timestamp: new Date(nowMs).toISOString(),
    level: statusCode >= 500 ? "error" : "warn",
    source: "server.route",
    name: "error_status",
    correlation: {
      traceId: context.traceId,
      requestId: context.requestId,
      method: context.method,
      route: context.route,
    },
    payload: {
      requestId: context.requestId,
      method: context.method,
      route: context.route,
      durationMs: nowMs - context.startedAtMs,
      statusCode,
    },
  };
}
