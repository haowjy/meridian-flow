import type { ExternalDevRoute } from "../portless-routes";
import type { SharedDevServicePorts } from "./dev-share-ports";
import type { TailscaleRouteBinding } from "./tailscale-stale-routes";

export interface TailscaleRouteVerification {
  ok: boolean;
  routes: ExternalDevRoute[];
  errors: string[];
}

function externalRouteUrl(nodeDnsName: string | undefined, httpsPort: number): string | undefined {
  const host = nodeDnsName?.replace(/\.$/, "");
  return host ? `https://${host}:${httpsPort}` : undefined;
}

function hasExpectedBinding(
  bindings: ReadonlyArray<TailscaleRouteBinding>,
  ports: SharedDevServicePorts,
): boolean {
  return bindings.some(
    (binding) =>
      binding.mode === ports.externalMode &&
      binding.httpsPort === ports.externalHttpsPort &&
      binding.localPort === ports.appBackendPort,
  );
}

function routeDescription(ports: SharedDevServicePorts): string {
  return `${ports.service} ${ports.externalMode} --https=${ports.externalHttpsPort} -> 127.0.0.1:${ports.appBackendPort}`;
}

/** Pure policy: external URLs are printable only after Tailscale reports the expected handler. */
export function verifyTailscaleExternalRoutes({
  sharedPorts,
  bindings,
  nodeDnsName,
}: {
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  bindings: ReadonlyArray<TailscaleRouteBinding>;
  nodeDnsName?: string;
}): TailscaleRouteVerification {
  const routes: ExternalDevRoute[] = [];
  const errors: string[] = [];

  for (const ports of sharedPorts) {
    if (!hasExpectedBinding(bindings, ports)) {
      errors.push(`missing Tailscale route binding for ${routeDescription(ports)}`);
      continue;
    }

    routes.push({
      service: ports.service,
      mode: ports.externalMode,
      httpsPort: ports.externalHttpsPort,
      url: externalRouteUrl(nodeDnsName, ports.externalHttpsPort),
    });
  }

  return { ok: errors.length === 0, routes, errors };
}
