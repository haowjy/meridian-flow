import { execFileSync } from "node:child_process";
import { loopbackOrigin } from "./dev-ports";

interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

function tailscale(args: string[]): string {
  try {
    return execFileSync("tailscale", args, {
      // The supervisor also runs this after its checkout, and so its working directory, is gone
      cwd: "/",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // `tailscale serve` waits forever when the tailnet has Serve or HTTPS turned off, after printing the link that turns it on
      timeout: 20_000,
    });
  } catch (error) {
    const { code, stderr, stdout, message } = error as {
      code?: string;
      stderr?: string;
      stdout?: string;
      message: string;
    };
    if (code === "ENOENT") throw new Error("the `tailscale` command is not on PATH");
    const output = [stderr, stdout].map((text) => text?.trim()).filter(Boolean);
    throw new Error(`\`tailscale ${args.join(" ")}\` failed: ${output.join("\n") || message}`);
  }
}

export function tailnetUrl(host: string, port: number): string {
  return `https://${host}:${port}`;
}

function routeOn(config: ServeConfig, host: string, port: number): "none" | "own" | "other" {
  if (!(String(port) in (config.TCP ?? {}))) return "none";
  const name = `${host}:${port}`;
  const handlers = config.Web?.[name]?.Handlers ?? {};
  const own =
    Object.keys(handlers).length === 1 &&
    handlers["/"]?.Proxy === loopbackOrigin(port) &&
    !config.AllowFunnel?.[name];
  return own ? "own" : "other";
}

function serveConfig(): ServeConfig {
  return JSON.parse(tailscale(["serve", "status", "--json"])) as ServeConfig;
}

export function unpublishFromTailnet(host: string, ports: readonly number[]): void {
  const config = serveConfig();
  for (const port of ports) {
    if (routeOn(config, host, port) === "own") tailscale(["serve", `--https=${port}`, "off"]);
  }
}

export function readTailnetHost(): string {
  const status = JSON.parse(tailscale(["status", "--json"])) as { Self?: { DNSName?: string } };
  const host = status.Self?.DNSName?.replace(/\.$/, "");
  if (!host) throw new Error("this machine has no tailnet name: `tailscale status` says why");
  return host;
}

export function assertTailnetPortsFree(host: string, ports: readonly number[]): void {
  const config = serveConfig();
  for (const port of ports) {
    if (routeOn(config, host, port) === "other") {
      throw new Error(
        `Tailscale already serves port ${port} for something else (\`tailscale serve status\`). Remove that route, or move this stack by changing DEV_PORT_BASE in its .env.local.`,
      );
    }
  }
}

export function publishOnTailnet(host: string, ports: readonly number[]): void {
  assertTailnetPortsFree(host, ports);
  for (const port of ports) tailscale(["serve", "--bg", `--https=${port}`, loopbackOrigin(port)]);
}
