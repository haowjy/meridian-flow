/** Validated on-disk launch identity and checkout-owned discovery of a running stack. */
import fs from "node:fs";
import path from "node:path";
import type { DevMode } from "./dev-mode";
import { isMainCheckout, resolveCheckoutSessionIdentity } from "./lib/dev-env";
import { pidBelongsToCheckout } from "./lib/route-ownership";
import { resolveCheckoutPortlessPrefix } from "./portless-prefix";
import {
  type ExternalDevRoute,
  resolveExpectedRouteUrls,
  resolvePortlessProxyPort,
  validateExpectedRoutes,
} from "./portless-routes";
import { TmuxSessionStore } from "./tmux-session-store";

export type ClientBuild = "development" | "production";

export interface DevSessionMetadata {
  sessionName: string;
  mode: DevMode;
  clientBuild: ClientBuild;
  branch: string;
  worktreePrefix?: string;
  /** Only the redacted launch command may be persisted. */
  command: string;
  createdAt: string;
  externalRoutes: ExternalDevRoute[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExternalRoute(value: unknown): value is ExternalDevRoute {
  return (
    isRecord(value) &&
    (value.service === "app" || value.service === "server" || value.service === "www") &&
    (value.mode === "serve" || value.mode === "funnel") &&
    typeof value.httpsPort === "number" &&
    Number.isInteger(value.httpsPort) &&
    value.httpsPort > 0 &&
    value.httpsPort <= 65535 &&
    (value.url === undefined || typeof value.url === "string")
  );
}

type StoredDevSessionMetadata = Omit<DevSessionMetadata, "clientBuild"> & {
  clientBuild?: ClientBuild;
};

function isMetadata(value: unknown): value is StoredDevSessionMetadata {
  return (
    isRecord(value) &&
    typeof value.sessionName === "string" &&
    /^meridian-[a-z0-9-]+-[a-f0-9]{8}$/.test(value.sessionName) &&
    (value.mode === "local" || value.mode === "tailscale" || value.mode === "funnel") &&
    (value.clientBuild === undefined ||
      value.clientBuild === "development" ||
      value.clientBuild === "production") &&
    typeof value.branch === "string" &&
    typeof value.command === "string" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.worktreePrefix === undefined ||
      (typeof value.worktreePrefix === "string" &&
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.worktreePrefix))) &&
    Array.isArray(value.externalRoutes) &&
    value.externalRoutes.every(isExternalRoute)
  );
}

export function readDevSessionMetadata(repoRoot: string): DevSessionMetadata | null {
  const filename = path.join(repoRoot, ".meridian", "dev-session.json");
  let content: string;
  try {
    content = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(content);
  const hash = resolveCheckoutSessionIdentity(repoRoot).worktreeHash;
  if (
    !isMetadata(value) ||
    !value.sessionName.endsWith(`-${hash}`) ||
    (!isMainCheckout(repoRoot) && !value.worktreePrefix)
  ) {
    throw new Error(`Invalid checkout session metadata: ${filename}`);
  }
  return { ...value, clientBuild: value.clientBuild ?? "development" };
}

export function writeDevSessionMetadata(repoRoot: string, metadata: DevSessionMetadata): void {
  const directory = path.join(repoRoot, ".meridian");
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `dev-session.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`);
    fs.renameSync(temporary, path.join(directory, "dev-session.json"));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readDevSessionState(repoRoot: string) {
  const recorded = readDevSessionMetadata(repoRoot);
  const active =
    recorded && new TmuxSessionStore(repoRoot).sessionExists(recorded.sessionName)
      ? recorded
      : null;
  return { recorded, active };
}

/** Current Git identity plans new launches; active metadata locates an existing launch. */
export function resolveCheckoutRouteUrls(
  repoRoot: string,
  output: string,
): { app: string; server: string } {
  const { active } = readDevSessionState(repoRoot);
  const worktreePrefix = active ? active.worktreePrefix : resolveCheckoutPortlessPrefix(repoRoot);
  const proxyPort = resolvePortlessProxyPort();
  const input = { output, mode: "local" as const, worktreePrefix, proxyPort };
  const validation = validateExpectedRoutes({
    ...input,
    ownsPid: (pid) => pidBelongsToCheckout(pid, repoRoot),
  });
  const urls = resolveExpectedRouteUrls(input);
  if (!validation.ok || !urls.app || !urls.server) {
    throw new Error(`This checkout's routes are unavailable: ${validation.errors.join("; ")}`);
  }
  return { app: urls.app, server: urls.server };
}
