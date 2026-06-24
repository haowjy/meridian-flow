/** Deterministic local backend and Tailscale HTTPS ports for shared dev services. */
import { createHash } from "node:crypto";
import type { DevMode } from "../dev-mode";

export type SharedDevServiceName = "app" | "www";
export type SharedDevRouteMode = "serve" | "funnel";

export interface SharedDevServicePorts {
  service: SharedDevServiceName;
  appBackendPort: number;
  externalMode: SharedDevRouteMode;
  externalHttpsPort: number;
}

const APP_BACKEND_PORT_RANGE = { start: 37_000, size: 8_000 } as const;
const TAILSCALE_HTTPS_PORT_RANGE = { start: 47_000, size: 8_000 } as const;
const FUNNEL_PORTS = [443, 8443, 10_000] as const;

function hashNumber(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

function deterministicPort({
  key,
  range,
  used,
}: {
  key: string;
  range: { start: number; size: number };
  used: Set<number>;
}): number {
  const offset = hashNumber(key) % range.size;

  for (let index = 0; index < range.size; index += 1) {
    const port = range.start + ((offset + index) % range.size);
    if (!used.has(port)) {
      used.add(port);
      return port;
    }
  }

  throw new Error(
    `no free deterministic port left in range ${range.start}-${range.start + range.size - 1}`,
  );
}

function funnelPortForService(service: SharedDevServiceName): number {
  const index = service === "app" ? 0 : 1;
  const port = FUNNEL_PORTS[index];
  if (!port) {
    throw new Error(`no reserved funnel port for ${service}`);
  }
  return port;
}

export function resolveSharedDevServicePorts({
  mode,
  worktreeKey,
  services,
}: {
  mode: DevMode;
  worktreeKey: string;
  services: ReadonlyArray<SharedDevServiceName>;
}): SharedDevServicePorts[] {
  if (mode === "local") return [];

  const usedBackendPorts = new Set<number>();
  const usedTailscalePorts = new Set<number>();

  return services.map((service) => ({
    service,
    appBackendPort: deterministicPort({
      key: `${worktreeKey}:${service}:app-backend`,
      range: APP_BACKEND_PORT_RANGE,
      used: usedBackendPorts,
    }),
    externalMode: mode === "funnel" ? "funnel" : "serve",
    externalHttpsPort:
      mode === "funnel"
        ? funnelPortForService(service)
        : deterministicPort({
            key: `${worktreeKey}:${service}:tailscale-https`,
            range: TAILSCALE_HTTPS_PORT_RANGE,
            used: usedTailscalePorts,
          }),
  }));
}
