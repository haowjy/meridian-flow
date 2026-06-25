import { afterEach, describe, expect, it } from "vitest";
import { resolveSsrApiOrigin, ssrApiRequestInitFromRequest } from "./ssr-api-request";

const previousApiOrigin = process.env.MERIDIAN_API_ORIGIN;

afterEach(() => {
  if (previousApiOrigin === undefined) {
    delete process.env.MERIDIAN_API_ORIGIN;
  } else {
    process.env.MERIDIAN_API_ORIGIN = previousApiOrigin;
  }
});

describe("SSR API origin resolution", () => {
  it("uses the configured internal API origin for Tailnet requests", () => {
    process.env.MERIDIAN_API_ORIGIN = "https://worktree.server.meridian.localhost";

    expect(
      resolveSsrApiOrigin(
        new Request("https://127.0.0.1:3000/project", {
          headers: {
            host: "writer-node.ts.net:47100",
            "x-forwarded-host": "writer-node.ts.net:47100",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe("https://worktree.server.meridian.localhost");
  });

  it("maps worktree app localhost hosts to the paired server origin in dev", () => {
    delete process.env.MERIDIAN_API_ORIGIN;

    expect(
      resolveSsrApiOrigin(new Request("https://dev-tooling-hardening.app.meridian.localhost/chat")),
    ).toBe("https://dev-tooling-hardening.server.meridian.localhost");
  });

  it("preserves cookies while using the internal origin", () => {
    process.env.MERIDIAN_API_ORIGIN = "https://server.meridian.localhost";

    expect(
      ssrApiRequestInitFromRequest(
        new Request("https://app.meridian.localhost/chat", {
          headers: { cookie: "wos-session=sealed" },
        }),
      ),
    ).toEqual({
      origin: "https://server.meridian.localhost",
      headers: { cookie: "wos-session=sealed" },
    });
  });
});
