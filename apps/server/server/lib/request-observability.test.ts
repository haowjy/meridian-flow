import { describe, expect, it } from "vitest";
import type { RequestObservabilityContext } from "./request-observability";
import { routeStatusEvent } from "./request-observability";

function context(route: string): RequestObservabilityContext {
  return {
    traceId: "trace",
    requestId: "request",
    method: "GET",
    route,
    startedAtMs: 1_000,
  };
}

describe("request observability route status events", () => {
  it("suppresses expected plain HTTP 426 statuses on WebSocket routes", () => {
    expect(routeStatusEvent(context("/api/threads/ws"), { status: 426 }, 1_050)).toBeNull();
    expect(routeStatusEvent(context("/ws/yjs"), { status: 426 }, 1_050)).toBeNull();
  });

  it("still emits other client and server route failures", () => {
    expect(routeStatusEvent(context("/api/threads/ws"), { status: 500 }, 1_050)).toMatchObject({
      level: "error",
      name: "error_status",
      payload: { statusCode: 500 },
    });
    expect(routeStatusEvent(context("/api/projects"), { status: 426 }, 1_050)).toMatchObject({
      level: "warn",
      name: "error_status",
      payload: { statusCode: 426 },
    });
  });
});
