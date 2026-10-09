import { describe, expect, it } from "vitest";

import { shouldProxyApiHttpPath } from "./api-http-dev-proxy-plugin";

describe("API HTTP dev proxy", () => {
  it.each(["/api/auth/callback"])("does not proxy app-owned route %s", (pathname) => {
    expect(shouldProxyApiHttpPath(pathname)).toBe(false);
  });

  it.each(["/api/auth/me"])("proxies server-owned route %s", (pathname) => {
    expect(shouldProxyApiHttpPath(pathname)).toBe(true);
  });

  it("leaves websocket upgrades to Vite's websocket proxy", () => {
    expect(shouldProxyApiHttpPath("/api/threads/ws", true)).toBe(false);
  });
});
