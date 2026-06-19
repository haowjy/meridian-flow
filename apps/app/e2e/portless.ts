import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { branchToPortlessPrefix } from "../../../tools/dev/portless-prefix";

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
  const candidates = activeRoutes(output, route);
  const branchPrefix = currentBranchPrefix();

  if (branchPrefix) {
    const preferredHost = `${branchPrefix}.${route}.meridian.localhost`;
    const preferred = candidates.find((url) => new URL(url).hostname === preferredHost);
    if (preferred) return preferred;
  }

  if (candidates.length === 1) return candidates[0];

  const overrideName = route === "app" ? "APP_URL" : "SERVER_URL";
  if (candidates.length === 0) {
    throw new Error(
      `No active ${route}.meridian portless route found. Run pnpm dev or set ${overrideName}.`,
    );
  }

  throw new Error(
    `Multiple active ${route}.meridian portless routes found (${candidates.join(", ")}). Set ${overrideName}.`,
  );
}

function activeRoutes(output: string, route: PortlessRoute): string[] {
  return output
    .split("\n")
    .map((line) => /^\s*(https:\/\/\S+)\s+->/.exec(line)?.[1])
    .filter((url): url is string => Boolean(url))
    .filter((url) => {
      const hostname = new URL(url).hostname;
      return (
        hostname === `${route}.meridian.localhost` ||
        hostname.endsWith(`.${route}.meridian.localhost`)
      );
    });
}

function currentBranchPrefix(): string | null {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  return branchToPortlessPrefix(branch) ?? null;
}
