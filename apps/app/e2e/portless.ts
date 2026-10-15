import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCheckoutRouteUrls } from "../../../tools/dev/dev-session-state";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

type PortlessRoute = "app" | "server";

export function resolveAppUrl(): string {
  return process.env.APP_URL?.trim() || discoverPortlessUrl("app");
}

export function resolveServerUrl(): string {
  return process.env.SERVER_URL?.trim() || discoverPortlessUrl("server");
}

function discoverPortlessUrl(route: PortlessRoute): string {
  const output = execFileSync("pnpm", ["portless:list"], { cwd: REPO_ROOT, encoding: "utf8" });
  return resolveCheckoutRouteUrls(REPO_ROOT, output)[route];
}
