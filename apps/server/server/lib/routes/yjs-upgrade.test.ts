/** CrossWS upgrade coverage for Yjs subprotocol echo response headers. */
import type { WS_CLOSE } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWsUpgradeAuth: vi.fn(),
  gateway: {},
}));

vi.mock("nitro", () => ({
  defineWebSocketHandler: <T>(hooks: T) => hooks,
}));

vi.mock("../ws-upgrade-auth.js", () => ({
  deferWsClose: (close: typeof WS_CLOSE.AUTH_FAILED) => ({ kind: "deferred-close", close }),
  resolveWsUpgradeAuth: mocks.resolveWsUpgradeAuth,
}));

vi.mock("../yjs-ws-handler.js", () => ({
  createYjsGateway: () => mocks.gateway,
  selectYjsGatewayServices: () => ({}),
}));

const { yjsWebSocketHandler } = await import("../../routes/ws/yjs.js");

const handler = yjsWebSocketHandler as unknown as {
  upgrade(request: Request): Promise<{
    context: { kind: string };
    headers?: { "sec-websocket-protocol": string };
  }>;
};

const cases = [
  {
    name: "selected protocol",
    offered: "unrelated, meridian.collab.0.1.0",
    selected: "meridian.collab.0.1.0",
  },
  {
    name: "absent protocol",
    offered: null,
    selected: undefined,
  },
] as const;

describe("Yjs WebSocket upgrade", () => {
  it.each(cases)("wires the $name echo response", async ({ offered, selected }) => {
    mocks.resolveWsUpgradeAuth.mockResolvedValue({
      kind: "authenticated",
      app: {},
      userId: "user-1",
    });

    const response = await handler.upgrade(
      new Request("https://meridian.local/ws/yjs", {
        ...(offered ? { headers: { "sec-websocket-protocol": offered } } : {}),
      }),
    );

    expect(response.context.kind).toBe("authenticated");
    if (selected) {
      expect(response.headers).toEqual({ "sec-websocket-protocol": selected });
    } else {
      expect("headers" in response).toBe(false);
    }
  });
});
