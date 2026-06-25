import { describe, expect, it } from "vitest";
import type { SharedDevServicePorts } from "../lib/dev-share-ports";
import { TailscaleDevLifecycle } from "../lib/tailscale-lifecycle";

const sharedPorts: SharedDevServicePorts[] = [
  {
    service: "app",
    appBackendPort: 43100,
    externalMode: "serve",
    externalHttpsPort: 47100,
  },
  {
    service: "www",
    appBackendPort: 43101,
    externalMode: "funnel",
    externalHttpsPort: 8443,
  },
];

function statusFor(port: number, localPort: number): string {
  return JSON.stringify({
    Web: {
      [`dev.tailnet.ts.net:${port}`]: {
        Handlers: {
          "/": { Proxy: `http://127.0.0.1:${localPort}` },
        },
      },
    },
  });
}

describe("tailscale dev lifecycle", () => {
  it("resolves the node DNS name from tailscale status", () => {
    const lifecycle = new TailscaleDevLifecycle({
      runTailscale: () => JSON.stringify({ Self: { DNSName: "dev.tailnet.ts.net." } }),
    });

    expect(lifecycle.resolveNodeDnsName()).toBe("dev.tailnet.ts.net");
  });

  it("registers missing expected routes before returning verified external URLs", () => {
    const calls: string[][] = [];
    const registered = new Set<string>();
    const lifecycle = new TailscaleDevLifecycle({
      runTailscale: (args) => {
        calls.push(args);

        if (args.join(" ") === "serve status --json") {
          return registered.has("serve") ? statusFor(47100, 43100) : JSON.stringify({});
        }
        if (args.join(" ") === "funnel status --json") {
          return registered.has("funnel") ? statusFor(8443, 43101) : JSON.stringify({});
        }
        if (args[0] === "serve" && args[1] === "--bg") {
          registered.add("serve");
          return "";
        }
        if (args[0] === "funnel" && args[1] === "--bg") {
          registered.add("funnel");
          return "";
        }

        throw new Error(`unexpected tailscale call: ${args.join(" ")}`);
      },
    });

    expect(
      lifecycle.ensureExternalRoutes({ sharedPorts, nodeDnsName: "dev.tailnet.ts.net" }),
    ).toEqual([
      {
        service: "app",
        mode: "serve",
        httpsPort: 47100,
        url: "https://dev.tailnet.ts.net:47100",
      },
      {
        service: "www",
        mode: "funnel",
        httpsPort: 8443,
        url: "https://dev.tailnet.ts.net:8443",
      },
    ]);

    expect(calls).toContainEqual([
      "serve",
      "--bg",
      "--yes",
      "--https=47100",
      "http://127.0.0.1:43100",
    ]);
    expect(calls).toContainEqual([
      "funnel",
      "--bg",
      "--yes",
      "--https=8443",
      "http://127.0.0.1:43101",
    ]);
  });

  it("prunes only stale routes and keeps cleanup surgical", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const lifecycle = new TailscaleDevLifecycle({
      runTailscale: (args) => {
        calls.push(args);

        if (args.join(" ") === "serve status --json") {
          return JSON.stringify({
            Web: {
              "dev.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } },
              "dev.tailnet.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3101" } } },
            },
          });
        }
        if (args.join(" ") === "funnel status --json") return JSON.stringify({});
        if (args.join(" ") === "serve --https=443 off") return "";

        throw new Error(`unexpected tailscale call: ${args.join(" ")}`);
      },
      isLocalPortListening: async (port) => port === 3101,
      logger: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
    });

    await lifecycle.pruneStaleRoutes();

    expect(calls).toContainEqual(["serve", "--https=443", "off"]);
    expect(calls).not.toContainEqual(["serve", "--https=8443", "off"]);
    expect(calls.flat()).not.toContain("reset");
    expect(logs).toEqual(["pruned 1 stale tailscale route"]);
  });

  it("cleans previous routes or expected routes when no previous metadata exists", () => {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const lifecycle = new TailscaleDevLifecycle({
      runTailscale: (args) => {
        calls.push(args);
        if (args.includes("--https=47100")) return "";
        throw { stderr: "handler does not exist" };
      },
      logger: { log: () => undefined, warn: (message) => warnings.push(message) },
    });

    lifecycle.cleanupExternalRoutes({ sharedPorts });

    expect(calls).toEqual([
      ["serve", "--https=47100", "off"],
      ["funnel", "--https=8443", "off"],
    ]);
    expect(warnings).toEqual([]);
  });
});
