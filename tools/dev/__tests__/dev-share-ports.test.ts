import { describe, expect, it } from "vitest";
import { resolveSharedDevServicePorts } from "../lib/dev-share-ports";

describe("shared dev service ports", () => {
  it("pins stable app backends and tailscale ports per worktree/service", () => {
    const first = resolveSharedDevServicePorts({
      mode: "tailscale",
      worktreeKey: "/repo/worktree-a",
      services: ["app", "www"],
    });
    const second = resolveSharedDevServicePorts({
      mode: "tailscale",
      worktreeKey: "/repo/worktree-a",
      services: ["app", "www"],
    });

    expect(second).toEqual(first);
    expect(new Set(first.map((ports) => ports.appBackendPort)).size).toBe(2);
    expect(new Set(first.map((ports) => ports.externalHttpsPort)).size).toBe(2);
    expect(first.map((ports) => ports.externalMode)).toEqual(["serve", "serve"]);
  });

  it("keeps local mode unshared and funnel on Tailscale-supported HTTPS ports", () => {
    expect(
      resolveSharedDevServicePorts({
        mode: "local",
        worktreeKey: "/repo/worktree-a",
        services: ["app", "www"],
      }),
    ).toEqual([]);

    expect(
      resolveSharedDevServicePorts({
        mode: "funnel",
        worktreeKey: "/repo/worktree-a",
        services: ["app", "www"],
      }).map((ports) => [ports.service, ports.externalMode, ports.externalHttpsPort]),
    ).toEqual([
      ["app", "funnel", 443],
      ["www", "funnel", 8443],
    ]);
  });
});
