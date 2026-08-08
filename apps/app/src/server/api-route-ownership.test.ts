import { describe, expect, it } from "vitest";

import { getApiRouteOwner } from "./api-route-ownership";

describe("API route ownership", () => {
  it.each([
    "/api/works",
    "/api/works/work-1",
    "/api/works/work-1/archive",
    "/api/works/work-1/unarchive",
    "/api/works/work-1/threads",
  ])("forwards the Work lifecycle path %s to the API server", (pathname) => {
    expect(getApiRouteOwner(pathname)).toBe("server");
  });

  it("does not claim adjacent app-shell paths", () => {
    expect(getApiRouteOwner("/api/workshop")).toBeNull();
    expect(getApiRouteOwner("/api/worksheets/work-1")).toBeNull();
  });

  it.each([
    "/api/auth/callback",
    "/api/auth/dev-login",
  ])("leaves the implemented auth route %s with the app", (pathname) => {
    expect(getApiRouteOwner(pathname)).toBe("app");
  });

  it.each([
    "/api/auth/me",
    "/api/auth/future-route",
    "/api/auth/callback/unimplemented",
    "/api/auth/dev-login/unimplemented",
  ])("forwards the server-owned auth route %s", (pathname) => {
    expect(getApiRouteOwner(pathname)).toBe("server");
  });
});
