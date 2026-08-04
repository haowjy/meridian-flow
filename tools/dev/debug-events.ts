/** LLM-friendly authenticated query client for the current worktree's recent server events. */
import { execFileSync } from "node:child_process";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import { portlessCa } from "./dev-readiness";
import { resolveCurrentRepoRoot, runGit } from "./lib/dev-env";
import { branchToPortlessPrefix } from "./portless-prefix";
import { resolveExpectedRouteUrls } from "./portless-routes";

type DebugQuery = {
  eventId?: string;
  source?: string;
  name?: string;
  level?: string;
  traceId?: string;
  threadId?: string;
  turnId?: string;
  documentId?: string;
  errorCode?: string;
  sinceTimestamp?: string;
  limit: number;
};

export type DebugEventsOptions = {
  query: DebugQuery;
  full: boolean;
};

const VALUE_FLAGS = new Map([
  ["--event", "eventId"],
  ["--source", "source"],
  ["--name", "name"],
  ["--level", "level"],
  ["--trace", "traceId"],
  ["--thread", "threadId"],
  ["--turn", "turnId"],
  ["--document", "documentId"],
  ["--error-code", "errorCode"],
  ["--since", "sinceTimestamp"],
] as const);
const PIVOT_KEYS = ["eventId", "traceId", "threadId", "turnId", "documentId", "errorCode"];

function usage(): string {
  return [
    "Usage: pnpm debug:events -- --trace <id> [filters]",
    "Pivots: --event --trace --thread --turn --document --error-code",
    "Filters: --source --name --level --since --limit --full",
  ].join("\n");
}

export function parseDebugEventsArgs(args: string[]): DebugEventsOptions {
  if (args[0] === "--") args = args.slice(1);
  const values: Record<string, string> = {};
  let full = false;
  let rawLimit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (flag === "--full") {
      full = true;
      continue;
    }
    if (flag === "--limit") {
      rawLimit = args[++index];
      if (!rawLimit) throw new Error(`--limit requires a value\n${usage()}`);
      continue;
    }
    const key = VALUE_FLAGS.get(flag as never);
    if (!key) throw new Error(`Unknown argument: ${flag}\n${usage()}`);
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value\n${usage()}`);
    values[key] = value;
  }
  if (!PIVOT_KEYS.some((key) => values[key])) {
    throw new Error(`A narrowing pivot is required.\n${usage()}`);
  }
  const requestedLimit = rawLimit === undefined ? (full ? 200 : 50) : Number(rawLimit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  const maxLimit = full ? 200 : 50;
  return {
    full,
    query: { ...values, limit: Math.min(requestedLimit, maxLimit) },
  };
}

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

function request(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const clientRequest = https.request(
      url,
      { method: "GET", headers, ca: portlessCa(), timeout: 5_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    clientRequest.on("timeout", () => clientRequest.destroy(new Error("request timed out")));
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

function resolveOrigins(repoRoot: string): { app: string; server: string } {
  let output: string;
  try {
    output = execFileSync("pnpm", ["portless:list"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Portless is unavailable. Start this worktree with `pnpm dev` and retry.");
  }
  const branchName = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const urls = resolveExpectedRouteUrls({
    output,
    mode: "local",
    worktreePrefix: branchToPortlessPrefix(branchName),
  });
  if (!urls.app || !urls.server) {
    throw new Error(
      "This worktree's app/server Portless routes are not running. Run `pnpm dev` and retry.",
    );
  }
  return { app: urls.app, server: urls.server };
}

function sessionCookie(headers: IncomingHttpHeaders): string {
  const cookies = headers["set-cookie"] ?? [];
  const cookieHeader = cookies
    .map((cookie) => cookie.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  if (!cookieHeader) {
    throw new Error("Dev login did not return a session cookie. Check WORKOS_DEV_AUTOLOGIN.");
  }
  return cookieHeader;
}

function compactEvent(value: unknown): Record<string, unknown> {
  const event = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    timestamp: event.timestamp ?? null,
    level: event.level ?? null,
    source: event.source ?? null,
    name: event.name ?? null,
    eventId: event.eventId ?? null,
    correlation: event.correlation ?? {},
  };
}

export async function queryDebugEvents(
  options: DebugEventsOptions,
  repoRoot = resolveCurrentRepoRoot(),
): Promise<Record<string, unknown>> {
  const origins = resolveOrigins(repoRoot);
  const login = await request(new URL("/api/auth/dev-login", origins.app).toString());
  if (login.status !== 302) {
    throw new Error(`Dev login failed with HTTP ${login.status}: ${login.body.slice(0, 400)}`);
  }
  const url = new URL("/api/debug/events", origins.server);
  for (const [key, value] of Object.entries(options.query))
    url.searchParams.set(key, String(value));
  const response = await request(url.toString(), { Cookie: sessionCookie(login.headers) });
  if (response.status !== 200) {
    throw new Error(
      `Event query failed with HTTP ${response.status}: ${response.body.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(response.body) as {
    events?: unknown[];
    dropped?: unknown;
    droppedBytes?: unknown;
  };
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return {
    query: options.query,
    events: options.full ? events : events.map(compactEvent),
    droppedRecords: typeof parsed.dropped === "number" ? parsed.dropped : 0,
    droppedBytes: typeof parsed.droppedBytes === "number" ? parsed.droppedBytes : 0,
  };
}

async function main(): Promise<void> {
  try {
    const result = await queryDebugEvents(parseDebugEventsArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
