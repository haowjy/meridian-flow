import { describe, expect, it } from "vitest";
import { devAuthAppliesToRequest, resolveDevAuthUser } from "./dev-auth";

describe("resolveDevAuthUser", () => {
  const on = { DEV_AUTH_BYPASS: "1" };

  it.each([
    ["off", { NODE_ENV: "development" }, null],
    ["off in production", { NODE_ENV: "production", APP_ENV: "production" }, null],
    ["local, APP_ENV unset", { ...on, NODE_ENV: "development" }, "test"],
    ["local, APP_ENV dev", { ...on, NODE_ENV: "development", APP_ENV: "dev" }, "test"],
    ["custom id", { ...on, NODE_ENV: "development", DEV_AUTH_USER_ID: "ada" }, "ada"],
    ["off under test", { ...on, NODE_ENV: "test" }, null],
  ])("%s", (_name, env, id) => {
    const user = resolveDevAuthUser(env);
    expect(user?.externalId ?? null).toBe(id);
    if (user) expect(user.email).toBe(`${id}@example.com`);
  });

  it.each([
    ["staging", { NODE_ENV: "production", APP_ENV: "staging" }],
    ["production", { NODE_ENV: "production", APP_ENV: "production" }],
    ["production NODE_ENV, APP_ENV unset", { NODE_ENV: "production" }],
    ["both unset", {}],
    ["development NODE_ENV on staging", { NODE_ENV: "development", APP_ENV: "staging" }],
  ])("refuses %s", (_name, env) => {
    expect(() => resolveDevAuthUser({ ...on, ...env })).toThrow(/DEV_AUTH_BYPASS/);
  });
});

describe("devAuthAppliesToRequest", () => {
  const req = (method: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost:20001/api/x", {
      method,
      headers: { host: "localhost:20001", ...headers },
    });

  it.each([
    ["no fetch metadata, no Origin (node client)", req("POST"), true],
    ["same-origin", req("POST", { "sec-fetch-site": "same-origin" }), true],
    ["same-site", req("POST", { "sec-fetch-site": "same-site" }), true],
    ["cross-site POST", req("POST", { "sec-fetch-site": "cross-site" }), false],
    [
      "WebSocket from a foreign origin (Chrome sends no sec-fetch-*)",
      req("GET", { origin: "https://evil.example", upgrade: "websocket" }),
      false,
    ],
    [
      "same-origin WebSocket",
      new Request("http://localhost:20000/ws/loro", {
        headers: {
          host: "localhost:20000",
          origin: "http://localhost:20000",
          upgrade: "websocket",
        },
      }),
      true,
    ],
    [
      "a page on another local port",
      new Request("http://localhost:20000/api/x", {
        method: "POST",
        headers: { host: "localhost:20000", origin: "http://localhost:8080" },
      }),
      false,
    ],
    ["Origin null", req("POST", { origin: "null" }), false],
    [
      "rebound Host",
      new Request("http://attacker.example:3000/api/x", {
        headers: { host: "attacker.example:3000" },
      }),
      false,
    ],
    [
      "tailnet origin through the proxy",
      req("POST", { origin: "https://laptop.tail1234.ts.net" }),
      true,
    ],
    [
      "cross-site top-level navigation",
      req("GET", {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      }),
      true,
    ],
    [
      "cross-site iframe",
      req("GET", {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      }),
      false,
    ],
  ])("%s", (_name, request, applies) => {
    expect(devAuthAppliesToRequest(request)).toBe(applies);
  });
});
