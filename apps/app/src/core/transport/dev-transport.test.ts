import { describe, expect, it } from "vitest";

import {
  buildSameOriginWsUrl,
  buildThreadsWsUrl,
  resolveApiDevOriginFallback,
  resolveApiDevOriginForAppHost,
} from "./dev-transport";

describe("resolveApiDevOriginFallback", () => {
  it("returns bare API origin without worktree prefix", () => {
    expect(resolveApiDevOriginFallback()).toBe("https://server.meridian.localhost");
  });

  it("returns worktree-prefixed API origin", () => {
    expect(resolveApiDevOriginFallback("zustand-migration")).toBe(
      "https://zustand-migration.server.meridian.localhost",
    );
  });
});

describe("resolveApiDevOriginForAppHost", () => {
  const fallback = "https://server.meridian.localhost";

  it("returns fallback for bare app host", () => {
    expect(resolveApiDevOriginForAppHost("app.meridian.localhost", fallback)).toBe(fallback);
  });

  it("maps worktree-prefixed app host to paired API origin", () => {
    expect(
      resolveApiDevOriginForAppHost("thread-first-chat.app.meridian.localhost", fallback),
    ).toBe("https://thread-first-chat.server.meridian.localhost");
  });

  it("returns fallback for ts.net hosts", () => {
    expect(resolveApiDevOriginForAppHost("pop-os.tail852a76.ts.net", fallback)).toBe(fallback);
    expect(resolveApiDevOriginForAppHost("pop-os.tail852a76.ts.net:8453", fallback)).toBe(fallback);
  });
});

describe("buildThreadsWsUrl", () => {
  it("uses same-origin host for bare ts.net (portless funnel default port)", () => {
    expect(
      buildThreadsWsUrl({
        protocol: "https:",
        hostname: "pop-os.tail852a76.ts.net",
        port: "",
        host: "pop-os.tail852a76.ts.net",
      }),
    ).toBe("wss://pop-os.tail852a76.ts.net/api/threads/ws");
  });

  it("uses same-origin host when ts.net app is on a portless-assigned port", () => {
    expect(
      buildThreadsWsUrl({
        protocol: "https:",
        hostname: "pop-os.tail852a76.ts.net",
        port: "8445",
        host: "pop-os.tail852a76.ts.net:8445",
      }),
    ).toBe("wss://pop-os.tail852a76.ts.net:8445/api/threads/ws");
  });

  it("uses same-origin host for localhost", () => {
    expect(
      buildThreadsWsUrl({
        protocol: "https:",
        hostname: "app.meridian.localhost",
        port: "",
        host: "app.meridian.localhost",
      }),
    ).toBe("wss://app.meridian.localhost/api/threads/ws");
  });

  it("builds same-origin Yjs websocket URLs", () => {
    expect(
      buildSameOriginWsUrl("/ws/yjs/doc%201", {
        protocol: "https:",
        hostname: "app.meridian.localhost",
        port: "",
        host: "app.meridian.localhost",
      }),
    ).toBe("wss://app.meridian.localhost/ws/yjs/doc%201");
  });
});
