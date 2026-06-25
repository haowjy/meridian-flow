import { describe, expect, it } from "vitest";
import { verifyTailscaleExternalRoutes } from "../lib/tailscale-external-routes";

const sharedPorts = [
  {
    service: "app" as const,
    appBackendPort: 43100,
    externalMode: "serve" as const,
    externalHttpsPort: 47100,
  },
  {
    service: "www" as const,
    appBackendPort: 43101,
    externalMode: "serve" as const,
    externalHttpsPort: 47101,
  },
];

describe("tailscale external route verification", () => {
  it("prints external routes only when status reports the expected handlers", () => {
    expect(
      verifyTailscaleExternalRoutes({
        sharedPorts,
        nodeDnsName: "dev.tailnet.ts.net.",
        bindings: [
          { mode: "serve", httpsPort: 47100, localPort: 43100 },
          { mode: "serve", httpsPort: 47101, localPort: 43101 },
        ],
      }),
    ).toEqual({
      ok: true,
      errors: [],
      routes: [
        {
          service: "app",
          mode: "serve",
          httpsPort: 47100,
          url: "https://dev.tailnet.ts.net:47100",
        },
        {
          service: "www",
          mode: "serve",
          httpsPort: 47101,
          url: "https://dev.tailnet.ts.net:47101",
        },
      ],
    });
  });

  it("rejects synthesized ports when the current Tailscale binding is missing", () => {
    expect(
      verifyTailscaleExternalRoutes({
        sharedPorts,
        bindings: [{ mode: "serve", httpsPort: 47100, localPort: 43100 }],
      }),
    ).toEqual({
      ok: false,
      routes: [
        {
          service: "app",
          mode: "serve",
          httpsPort: 47100,
          url: undefined,
        },
      ],
      errors: ["missing Tailscale route binding for www serve --https=47101 -> 127.0.0.1:43101"],
    });
  });

  it("requires the handler to point at the expected local backend port", () => {
    expect(
      verifyTailscaleExternalRoutes({
        sharedPorts: [sharedPorts[0]],
        bindings: [{ mode: "serve", httpsPort: 47100, localPort: 49999 }],
      }),
    ).toMatchObject({
      ok: false,
      errors: ["missing Tailscale route binding for app serve --https=47100 -> 127.0.0.1:43100"],
    });
  });
});
