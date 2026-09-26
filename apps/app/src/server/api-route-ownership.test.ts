import { describe, expect, it } from "vitest";

import { getApiRouteOwner } from "./api-route-ownership";

describe("API route ownership", () => {
  it("forwards project ID lookup without claiming adjacent routes", () => {
    expect(getApiRouteOwner("/api/projects/550e8400-e29b-41d4-a716-446655440000")).toBe("server");
    expect(getApiRouteOwner("/api/projects-other/id")).toBeNull();
  });
  it.each([
    "/api/works",
    "/api/works/work-1",
  ])("forwards the Work lifecycle path %s to the API server", (pathname) => {
    expect(getApiRouteOwner(pathname)).toBe("server");
  });

  it("does not claim adjacent app-shell paths", () => {
    expect(getApiRouteOwner("/api/workshop")).toBeNull();
    expect(getApiRouteOwner("/api/worksheets/work-1")).toBeNull();
  });

  it("forwards GET /api/skills to the API server without claiming nested paths", () => {
    expect(getApiRouteOwner("/api/skills")).toBe("server");
    expect(getApiRouteOwner("/api/skills/extra")).toBeNull();
  });

  it.each([
    "/api/auth/callback/unimplemented",
  ])("forwards the server-owned auth route %s", (pathname) => {
    expect(getApiRouteOwner(pathname)).toBe("server");
  });
});
