import { describe, expect, it } from "vitest";

import { isApiOwnedPath, isAppOwnedAuthPath } from "./api-route-ownership";

describe("API route ownership", () => {
  it.each([
    "/api/works",
    "/api/works/work-1",
    "/api/works/work-1/archive",
    "/api/works/work-1/unarchive",
    "/api/works/work-1/threads",
  ])("forwards the Work lifecycle path %s to the API server", (pathname) => {
    expect(isApiOwnedPath(pathname)).toBe(true);
  });

  it("does not claim adjacent app-shell paths", () => {
    expect(isApiOwnedPath("/api/workshop")).toBe(false);
    expect(isApiOwnedPath("/api/worksheets/work-1")).toBe(false);
  });

  it("leaves app-owned auth routes with the app", () => {
    expect(isAppOwnedAuthPath("/api/auth/callback")).toBe(true);
    expect(isApiOwnedPath("/api/auth/callback")).toBe(false);
  });
});
