/**
 * Request observability plugin: mints per-request correlation and emits one safe
 * global event for unexpected route failures and handled error statuses.
 */
import { emitEvent, unknownToEventPayload } from "../domains/observability/index.js";
import { getProcessEventSink } from "../lib/observability.js";
import {
  createRequestObservabilityContext,
  getRequestObservabilityContext,
  markUnexpectedRouteFailureEmitted,
  type RequestObservabilityEvent,
  type RequestObservabilityResponse,
  routeStatusEvent,
  shouldEmitUnexpectedRouteFailure,
  unexpectedRouteFailureWasEmitted,
} from "../lib/request-observability.js";

const eventSink = getProcessEventSink();

type NitroHookApp = {
  hooks: {
    hook(name: "request", handler: (event: RequestObservabilityEvent) => void): void;
    hook(
      name: "error",
      handler: (error: unknown, context: { event?: RequestObservabilityEvent }) => void,
    ): void;
    hook(
      name: "response",
      handler: (response: RequestObservabilityResponse, event: RequestObservabilityEvent) => void,
    ): void;
  };
};

export default function requestObservabilityPlugin(app: unknown) {
  const nitroApp = app as NitroHookApp;
  nitroApp.hooks.hook("request", (event) => {
    event.context.observability = createRequestObservabilityContext(event);
  });

  nitroApp.hooks.hook("error", (error, { event }) => {
    if (!event) return;
    if (!shouldEmitUnexpectedRouteFailure(error)) return;
    const context = getRequestObservabilityContext(event);
    if (!context) return;
    markUnexpectedRouteFailureEmitted(event);
    emitEvent(eventSink, {
      level: "error",
      source: "server.route",
      name: "failed",
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
        durationMs: Date.now() - context.startedAtMs,
        ...unknownToEventPayload(error),
      },
    });
  });

  nitroApp.hooks.hook("response", (response, event) => {
    if (unexpectedRouteFailureWasEmitted(event)) return;
    const context = getRequestObservabilityContext(event);
    if (!context) return;
    const statusEvent = routeStatusEvent(context, response);
    if (!statusEvent) return;
    emitEvent(eventSink, statusEvent);
  });
}
