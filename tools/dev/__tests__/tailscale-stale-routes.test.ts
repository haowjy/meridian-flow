import { describe, expect, it } from "vitest";
import {
  findStaleTailscaleRoutes,
  parseTailscaleServeStatusJson,
  type TailscaleRouteBinding,
  tailscaleRouteOffArgs,
} from "../lib/tailscale-stale-routes";

describe("tailscale stale route pruning", () => {
  it("returns exactly dead-target serve and funnel routes without live targets", () => {
    const bindings: TailscaleRouteBinding[] = [
      { mode: "serve", httpsPort: 443, localPort: 3100 },
      { mode: "serve", httpsPort: 8443, localPort: 3101 },
      { mode: "funnel", httpsPort: 8444, localPort: 3102 },
      { mode: "funnel", httpsPort: 8445, localPort: 3103 },
    ];
    const livePorts = new Set([3101, 3103]);

    expect(findStaleTailscaleRoutes(bindings, (port) => livePorts.has(port))).toEqual([
      { mode: "serve", httpsPort: 443 },
      { mode: "funnel", httpsPort: 8444 },
    ]);
  });

  it("returns empty when all targets are live", () => {
    const bindings: TailscaleRouteBinding[] = [
      { mode: "serve", httpsPort: 443, localPort: 3100 },
      { mode: "funnel", httpsPort: 8443, localPort: 3101 },
    ];

    expect(findStaleTailscaleRoutes(bindings, () => true)).toEqual([]);
  });

  it("does not prune an https route when any target on that route is live", () => {
    const bindings: TailscaleRouteBinding[] = [
      { mode: "serve", httpsPort: 443, localPort: 3100 },
      { mode: "serve", httpsPort: 443, localPort: 3101 },
    ];

    expect(findStaleTailscaleRoutes(bindings, (port) => port === 3101)).toEqual([]);
  });

  it("parses serve status json and marks allow-funnel routes as funnel", () => {
    const status = {
      Web: {
        "dev.tailnet.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:3000" },
          },
        },
        "dev.tailnet.ts.net:8443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:3001" },
          },
        },
      },
      AllowFunnel: {
        "dev.tailnet.ts.net:8443": true,
      },
    };

    expect(parseTailscaleServeStatusJson(status)).toEqual([
      { mode: "serve", httpsPort: 443, localPort: 3000 },
      { mode: "funnel", httpsPort: 8443, localPort: 3001 },
    ]);
  });

  it("emits only surgical per-port off commands and never reset", () => {
    const args = [
      tailscaleRouteOffArgs({ mode: "serve", httpsPort: 443 }),
      tailscaleRouteOffArgs({ mode: "funnel", httpsPort: 8443 }),
    ];

    expect(args).toEqual([
      ["serve", "--https=443", "off"],
      ["funnel", "--https=8443", "off"],
    ]);
    expect(args.flat()).not.toContain("reset");
  });
});
