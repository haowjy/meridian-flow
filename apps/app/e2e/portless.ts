import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCheckoutPortlessPrefix } from "../../../tools/dev/portless-prefix";
import { resolveExpectedRouteUrls } from "../../../tools/dev/portless-routes";

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
  const urls = resolveExpectedRouteUrls({
    output,
    mode: "local",
    worktreePrefix: resolveCheckoutPortlessPrefix(REPO_ROOT),
  });
  if (urls[route]) return urls[route];
  const overrideName = route === "app" ? "APP_URL" : "SERVER_URL";
  throw new Error(
    `This checkout's ${route} Portless route is not running. Run pnpm dev or set ${overrideName}.`,
  );
}
