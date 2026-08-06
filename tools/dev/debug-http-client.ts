/** Authenticated, bounded HTTP client shared by local diagnostic CLIs. */
import { execFileSync } from "node:child_process";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { portlessCa } from "./dev-readiness";
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { branchToPortlessPrefix } from "./portless-prefix";
import { resolveExpectedRouteUrls } from "./portless-routes";

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
const COMMAND_DEADLINE_MS = 5_000;
const LOGIN_RESPONSE_BYTES = 64 * 1_024;

export function createBoundedResponseCollector(maxBytes: number) {
  let receivedBytes = 0;
  const chunks: Buffer[] = [];
  return {
    push(chunk: Uint8Array | string): void {
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > maxBytes) {
        throw new Error(`response exceeded the ${maxBytes}-byte safety limit`);
      }
      chunks.push(buffer);
    },
    body(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function request(
  url: string,
  headers: Record<string, string>,
  maxResponseBytes: number,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      operation();
    };
    const clientRequest = https.request(
      url,
      { method: "GET", headers, ca: portlessCa() },
      (response) => {
        const collector = createBoundedResponseCollector(maxResponseBytes);
        response.on("data", (chunk) => {
          try {
            collector.push(chunk);
          } catch (error) {
            clientRequest.destroy(error as Error);
          }
        });
        response.on("end", () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: collector.body(),
            }),
          ),
        );
      },
    );
    const deadline = setTimeout(
      () => clientRequest.destroy(new Error("debug query exceeded its 5-second deadline")),
      timeoutMs,
    );
    clientRequest.on("error", (error) => finish(() => reject(error)));
    clientRequest.end();
  });
}

function remainingCommandMs(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("debug query exceeded its 5-second deadline");
  return remaining;
}

function resolveOrigins(repoRoot: string, deadlineAt: number): { app: string; server: string } {
  let output: string;
  try {
    output = execFileSync("pnpm", ["portless:list"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: remainingCommandMs(deadlineAt),
    });
  } catch {
    remainingCommandMs(deadlineAt);
    throw new Error("Portless is unavailable. Start this worktree with `pnpm dev` and retry.");
  }
  const branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: remainingCommandMs(deadlineAt),
  }).trim();
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

export async function getAuthenticatedDebugJson(input: {
  path: string;
  maxResponseBytes: number;
  repoRoot?: string;
}): Promise<unknown> {
  const deadlineAt = Date.now() + COMMAND_DEADLINE_MS;
  const repoRoot =
    input.repoRoot ?? resolveCurrentRepoRoot(process.cwd(), remainingCommandMs(deadlineAt));
  const origins = resolveOrigins(repoRoot, deadlineAt);
  const login = await request(
    new URL("/api/auth/dev-login", origins.app).toString(),
    {},
    LOGIN_RESPONSE_BYTES,
    remainingCommandMs(deadlineAt),
  );
  if (login.status !== 302) {
    throw new Error(`Dev login failed with HTTP ${login.status}: ${login.body.slice(0, 400)}`);
  }
  const response = await request(
    new URL(input.path, origins.server).toString(),
    { Cookie: sessionCookie(login.headers) },
    input.maxResponseBytes,
    remainingCommandMs(deadlineAt),
  );
  if (response.status !== 200) {
    throw new Error(
      `Debug query failed with HTTP ${response.status}: ${response.body.slice(0, 400)}`,
    );
  }
  return JSON.parse(response.body) as unknown;
}
