import { describe, expect, it } from "vitest";
import {
  formatDevRouteLines,
  getExpectedServicesForMode,
  parsePortlessListOutput,
  validateExpectedRoutes,
} from "./portless-routes";

const ROUTES_WITH_SHARING = `
Active routes:

  https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
    tailscale: https://api.tail.ts.net
    funnel: https://api.tail.ts.net
  https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
    tailscale: https://app.tail.ts.net
    funnel: https://app.tail.ts.net
  https://web.meridian.localhost  ->  localhost:4688  (pid 3333)
`;

const WORKTREE_AND_MAIN_ROUTES = `
  https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
  https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
  https://zustand-migration.server.meridian.localhost  ->  localhost:5627  (pid 3333)
    tailscale: https://api-worktree.tail.ts.net
  https://zustand-migration.app.meridian.localhost  ->  localhost:5523  (pid 4444)
    tailscale: https://app-worktree.tail.ts.net
  https://zustand-migration.web.meridian.localhost  ->  localhost:5688  (pid 5555)
    tailscale: https://www-worktree.tail.ts.net
`;

describe("parsePortlessListOutput", () => {
  it("parses routes, pids, and sharing lines", () => {
    const parsed = parsePortlessListOutput(ROUTES_WITH_SHARING);

    expect(parsed.routes).toHaveLength(3);
    expect(parsed.routes[0]?.pid).toBe(1111);
    expect(parsed.routes[0]?.tailscale).toEqual(["https://api.tail.ts.net"]);
    expect(parsed.routes[1]?.funnel).toEqual(["https://app.tail.ts.net"]);
  });
});

describe("formatDevRouteLines", () => {
  it("prints full localhost URLs with app before server", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4090  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
    `;

    expect(formatDevRouteLines(output, "local")).toEqual([
      "app  local  https://app.meridian.localhost",
      "server  local  https://server.meridian.localhost",
    ]);
  });

  it("uses the worktree-prefixed routes when a worktree prefix is provided", () => {
    expect(formatDevRouteLines(WORKTREE_AND_MAIN_ROUTES, "local", "zustand-migration")).toEqual([
      "app  local  https://zustand-migration.app.meridian.localhost",
      "server  local  https://zustand-migration.server.meridian.localhost",
    ]);
  });

  it("uses bare routes for the main checkout and excludes worktree-prefixed routes", () => {
    expect(formatDevRouteLines(WORKTREE_AND_MAIN_ROUTES, "local")).toEqual([
      "app  local  https://app.meridian.localhost",
      "server  local  https://server.meridian.localhost",
    ]);
  });

  it("prints local and tailscale URLs with app and www first (server localhost-only)", () => {
    const output = `
      https://thread-first-chat.server.meridian.localhost  ->  localhost:4090  (pid 1111)
      https://thread-first-chat.app.meridian.localhost  ->  localhost:4523  (pid 2222)
        tailscale: https://pop-os.tail852a76.ts.net:8453
      https://thread-first-chat.web.meridian.localhost  ->  localhost:4688  (pid 3333)
        tailscale: https://pop-os.tail852a76.ts.net:8454
    `;

    expect(formatDevRouteLines(output, "tailscale", "thread-first-chat")).toEqual([
      "app  local  https://thread-first-chat.app.meridian.localhost",
      "app  ts     https://pop-os.tail852a76.ts.net:8453",
      "www  local  https://thread-first-chat.web.meridian.localhost",
      "www  ts     https://pop-os.tail852a76.ts.net:8454",
      "server  local  https://thread-first-chat.server.meridian.localhost",
    ]);
  });
});

describe("validateExpectedRoutes", () => {
  it("accepts worktree-prefixed app+server routes in local mode", () => {
    const output = `
      https://thread-first-chat.server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://thread-first-chat.app.meridian.localhost  ->  localhost:4523  (pid 2222)
    `;

    const result = validateExpectedRoutes({
      output,
      mode: "local",
      worktreePrefix: "thread-first-chat",
    });
    expect(result.ok).toBe(true);
    expect(result.servicePids).toEqual({ server: 1111, app: 2222 });
  });

  it("does not accept main checkout routes for a linked worktree", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
    `;

    const result = validateExpectedRoutes({
      output,
      mode: "local",
      worktreePrefix: "zustand-migration",
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing route for server");
    expect(result.errors.join(" ")).toContain("missing route for app");
  });

  it("requires app+server by default but not www", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
    `;

    const result = validateExpectedRoutes({ output, mode: "local" });
    expect(result.ok).toBe(true);
  });

  it("does not let an optional www route satisfy a missing app/server health gate", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://web.meridian.localhost  ->  localhost:4688  (pid 3333)
    `;

    const result = validateExpectedRoutes({ output, mode: "local" });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing route for app");
  });

  it("requires route pid evidence before routes can prove session ownership", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
    `;

    const result = validateExpectedRoutes({ output, mode: "local" });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing route pid for server");
  });

  it("accepts server with localhost-only evidence in tailscale mode", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
        tailscale: https://app.tail.ts.net
      https://web.meridian.localhost  ->  localhost:4688  (pid 3333)
        tailscale: https://www.tail.ts.net
    `;

    const result = validateExpectedRoutes({ output, mode: "tailscale" });
    expect(result.ok).toBe(true);
    expect(result.servicePids).toEqual({ server: 1111, app: 2222, www: 3333 });
  });

  it("requires tailscale share lines for shared services in tailscale mode", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
      https://web.meridian.localhost  ->  localhost:4688  (pid 3333)
    `;

    const result = validateExpectedRoutes({ output, mode: "tailscale" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing tailscale share for app");
    expect(result.errors.join(" ")).toContain("missing tailscale share for www");
    expect(result.errors.join(" ")).not.toContain("missing tailscale share for server");
  });

  it("requires www in tailscale mode because dev-tmux starts @meridian/www", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
        tailscale: https://app.tail.ts.net
    `;

    const result = validateExpectedRoutes({ output, mode: "tailscale" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing route for www");
  });

  it("getExpectedServicesForMode includes www for tailscale and funnel only", () => {
    expect(getExpectedServicesForMode("local").map((service) => service.name)).toEqual([
      "server",
      "app",
    ]);
    expect(getExpectedServicesForMode("tailscale").map((service) => service.name)).toEqual([
      "server",
      "app",
      "www",
    ]);

    const tailscale = getExpectedServicesForMode("tailscale");
    expect(tailscale.find((service) => service.name === "server")?.shared).toBe(false);
    expect(tailscale.find((service) => service.name === "app")?.shared).toBe(true);
    expect(tailscale.find((service) => service.name === "www")?.shared).toBe(true);
  });

  it("accepts server with localhost-only evidence in funnel mode", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
        funnel: https://app.tail.ts.net
      https://web.meridian.localhost  ->  localhost:4688  (pid 3333)
        funnel: https://www.tail.ts.net
    `;
    const result = validateExpectedRoutes({ output, mode: "funnel" });

    expect(result.ok).toBe(true);
  });

  it("requires funnel share lines for shared services in funnel mode", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
        funnel: https://app.tail.ts.net
      https://web.meridian.localhost  ->  localhost:4688  (pid 3333)
    `;

    const result = validateExpectedRoutes({ output, mode: "funnel" });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing funnel share for www");
    expect(result.errors.join(" ")).not.toContain("missing funnel share for server");
  });

  it("does not accept tailscale-only sharing evidence in funnel mode", () => {
    const output = `
      https://server.meridian.localhost  ->  localhost:4627  (pid 1111)
      https://app.meridian.localhost  ->  localhost:4523  (pid 2222)
        tailscale: https://app.tail.ts.net
      https://web.meridian.localhost  ->  localhost:4688  (pid 3333)
        tailscale: https://www.tail.ts.net
    `;

    const result = validateExpectedRoutes({ output, mode: "funnel" });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("missing funnel share for app");
    expect(result.errors.join(" ")).toContain("missing funnel share for www");
  });
});
