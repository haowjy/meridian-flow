/**
 * ssr-api-request tests — guards the SSR-only API origin resolver that keeps
 * portless cold-load route fetches on the public app→API pairing instead of
 * Nitro's private 127.0.0.1 upstream URL.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSsrApiOrigin, ssrApiRequestInitFromRequest } from "./ssr-api-request";

const originalMeridianApiOrigin = process.env.MERIDIAN_API_ORIGIN;
const originalNodeEnv = process.env.NODE_ENV;

function request(headers: HeadersInit): Request {
  return new Request("https://127.0.0.1:4379/project/project-id", { headers });
}

describe("resolveSsrApiOrigin", () => {
  beforeEach(() => {
    delete process.env.MERIDIAN_API_ORIGIN;
    process.env.NODE_ENV = "development";
  });

  afterAll(() => {
    if (originalMeridianApiOrigin === undefined) {
      delete process.env.MERIDIAN_API_ORIGIN;
    } else {
      process.env.MERIDIAN_API_ORIGIN = originalMeridianApiOrigin;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
      return;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("uses configured MERIDIAN_API_ORIGIN first in any runtime", () => {
    process.env.NODE_ENV = "production";
    process.env.MERIDIAN_API_ORIGIN = "https://configured-api.example.test";

    expect(resolveSsrApiOrigin(request({ "x-forwarded-host": "app.meridian.localhost" }))).toBe(
      "https://configured-api.example.test",
    );
  });

  it("maps the forwarded public app host instead of the internal request URL", () => {
    expect(
      resolveSsrApiOrigin(
        request({
          host: "127.0.0.1:4379",
          "x-forwarded-host": "experiment.app.meridian.localhost",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://experiment.server.meridian.localhost");
  });

  it("falls back to the public Host header when forwarded host is absent", () => {
    expect(resolveSsrApiOrigin(request({ host: "app.meridian.localhost" }))).toBe(
      "https://server.meridian.localhost",
    );
  });

  it("uses same-origin app proxy for tailnet hosts", () => {
    expect(
      resolveSsrApiOrigin(
        request({
          host: "127.0.0.1:4379",
          "x-forwarded-host": "pop-os.tail852a76.ts.net:8467",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://pop-os.tail852a76.ts.net:8467");
  });

  it("does not invent a localhost origin outside dev when MERIDIAN_API_ORIGIN is missing", () => {
    process.env.NODE_ENV = "production";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveSsrApiOrigin(request({ host: "staging.meridian.example" }))).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "MERIDIAN_API_ORIGIN is required for SSR API requests outside local development; skipping SSR API seeding.",
    );

    errorSpy.mockRestore();
  });

  it("forwards the cookie alongside the resolved origin", () => {
    expect(
      ssrApiRequestInitFromRequest(
        request({
          cookie: "sb-access-token=abc",
          "x-forwarded-host": "experiment.app.meridian.localhost",
        }),
      ),
    ).toEqual({
      origin: "https://experiment.server.meridian.localhost",
      headers: { cookie: "sb-access-token=abc" },
    });
  });
});
