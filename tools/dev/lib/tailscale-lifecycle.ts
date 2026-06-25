/** Tailscale serve/funnel lifecycle used by local dev startup. */
import { execFileSync } from "node:child_process";
import net from "node:net";
import type { ExternalDevRoute } from "../portless-routes";
import type { SharedDevServicePorts } from "./dev-share-ports";
import { verifyTailscaleExternalRoutes } from "./tailscale-external-routes";
import {
  findStaleTailscaleRoutes,
  parseTailscaleServeStatusJson,
  type TailscaleRouteBinding,
  type TailscaleRouteToPrune,
  tailscaleRouteOffArgs,
} from "./tailscale-stale-routes";

type TailscaleCommand = (args: string[]) => string;
type LocalPortProbe = (port: number) => Promise<boolean>;
type Logger = Pick<typeof console, "log" | "warn">;

export interface TailscaleDevLifecycleOptions {
  runTailscale?: TailscaleCommand;
  isLocalPortListening?: LocalPortProbe;
  logger?: Logger;
}

function runTailscale(args: string[]): string {
  return execFileSync("tailscale", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.toString().trim()) return stderr.toString().trim();
  }

  return error instanceof Error ? error.message : String(error);
}

function readStatusJson(run: TailscaleCommand, args: string[]): unknown | null {
  try {
    return JSON.parse(run(args)) as unknown;
  } catch {
    return null;
  }
}

function readRouteBindings(run: TailscaleCommand): TailscaleRouteBinding[] {
  const seen = new Set<string>();
  const bindings: TailscaleRouteBinding[] = [];

  for (const { args, modeOverride } of [
    { args: ["serve", "status", "--json"], modeOverride: undefined },
    { args: ["funnel", "status", "--json"], modeOverride: "funnel" as const },
  ]) {
    const status = readStatusJson(run, args);
    if (!status) continue;

    for (const parsedBinding of parseTailscaleServeStatusJson(status)) {
      const binding = modeOverride ? { ...parsedBinding, mode: modeOverride } : parsedBinding;
      const key = `${binding.mode}:${binding.httpsPort}:${binding.localPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push(binding);
    }
  }

  return bindings;
}

function expectedExternalRoutes(
  sharedPorts: ReadonlyArray<SharedDevServicePorts>,
): ExternalDevRoute[] {
  return sharedPorts.map((ports) => ({
    service: ports.service,
    mode: ports.externalMode,
    httpsPort: ports.externalHttpsPort,
  }));
}

function defaultLocalPortProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (live: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };

    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export class TailscaleDevLifecycle {
  private readonly runTailscale: TailscaleCommand;
  private readonly isLocalPortListening: LocalPortProbe;
  private readonly logger: Logger;

  constructor(options: TailscaleDevLifecycleOptions = {}) {
    this.runTailscale = options.runTailscale ?? runTailscale;
    this.isLocalPortListening = options.isLocalPortListening ?? defaultLocalPortProbe;
    this.logger = options.logger ?? console;
  }

  resolveNodeDnsName(): string | undefined {
    const status = readStatusJson(this.runTailscale, ["status", "--json"]);
    if (typeof status !== "object" || status === null || !("Self" in status)) return undefined;

    const self = (status as { Self?: { DNSName?: unknown } }).Self;
    return typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : undefined;
  }

  async pruneStaleRoutes(): Promise<void> {
    const bindings = readRouteBindings(this.runTailscale);
    if (bindings.length === 0) return;

    const liveness = new Map<number, boolean>();
    for (const localPort of [...new Set(bindings.map((binding) => binding.localPort))]) {
      liveness.set(localPort, await this.isLocalPortListening(localPort));
    }

    const staleRoutes = findStaleTailscaleRoutes(bindings, (port) => liveness.get(port) ?? false);
    let pruned = 0;

    for (const route of staleRoutes) {
      if (this.disableRoute(route)) {
        pruned += 1;
      }
    }

    if (pruned > 0) {
      this.logger.log(`pruned ${pruned} stale tailscale route${pruned === 1 ? "" : "s"}`);
    }
  }

  cleanupExternalRoutes({
    previousRoutes,
    sharedPorts,
  }: {
    previousRoutes?: ReadonlyArray<ExternalDevRoute>;
    sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  }): void {
    for (const route of previousRoutes ?? expectedExternalRoutes(sharedPorts)) {
      this.disableRoute(route);
    }
  }

  ensureExternalRoutes({
    sharedPorts,
    nodeDnsName,
  }: {
    sharedPorts: ReadonlyArray<SharedDevServicePorts>;
    nodeDnsName?: string;
  }): ExternalDevRoute[] {
    if (sharedPorts.length === 0) return [];

    try {
      return this.verifyExternalRoutes({ sharedPorts, nodeDnsName });
    } catch {
      this.registerExpectedRoutes(sharedPorts);
      return this.verifyExternalRoutes({ sharedPorts, nodeDnsName });
    }
  }

  private registerExpectedRoutes(sharedPorts: ReadonlyArray<SharedDevServicePorts>): void {
    for (const ports of sharedPorts) {
      const command = ports.externalMode === "funnel" ? "funnel" : "serve";
      const args = [
        command,
        "--bg",
        "--yes",
        `--https=${ports.externalHttpsPort}`,
        `http://127.0.0.1:${ports.appBackendPort}`,
      ];

      try {
        this.runTailscale(args);
      } catch (error) {
        throw new Error(
          `tailscale ${command} --https=${ports.externalHttpsPort} failed: ${commandErrorText(error)}`,
        );
      }
    }
  }

  private verifyExternalRoutes({
    sharedPorts,
    nodeDnsName,
  }: {
    sharedPorts: ReadonlyArray<SharedDevServicePorts>;
    nodeDnsName?: string;
  }): ExternalDevRoute[] {
    const verification = verifyTailscaleExternalRoutes({
      sharedPorts,
      bindings: readRouteBindings(this.runTailscale),
      nodeDnsName,
    });

    if (!verification.ok) {
      throw new Error(`Tailscale route verification failed: ${verification.errors.join("; ")}`);
    }

    return verification.routes;
  }

  private disableRoute(
    route: Pick<ExternalDevRoute | TailscaleRouteToPrune, "mode" | "httpsPort">,
  ): boolean {
    try {
      this.runTailscale(tailscaleRouteOffArgs(route));
      return true;
    } catch (error) {
      const message = commandErrorText(error);
      if (!/handler does not exist/i.test(message)) {
        this.logger.warn(
          `tailscale ${route.mode} --https=${route.httpsPort} off warning: ${message}`,
        );
      }
      return false;
    }
  }
}
