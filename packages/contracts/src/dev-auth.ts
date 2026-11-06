/**
 * Local dev auth bypass: the one rule both the app and the server use to decide
 * whether every request is the dev user. `DEV_AUTH_BYPASS=1` turns it on; it is
 * allowed only for a local dev process and refused anywhere else.
 *
 * Callers pass raw `process.env`, never a validated env object whose defaults
 * (`NODE_ENV=development`, `APP_ENV=dev`) would make an unset deployed process
 * look local.
 */

export interface DevAuthUser {
  /** Stored as `users.external_id`, the key `ensureUser` upserts on. */
  externalId: string;
  email: string;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_DEV_AUTH_USER_ID = "test";
const DEV_AUTH_USER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The dev user's identity. Ungated: scripts that only need it read it without `NODE_ENV`. */
export function devAuthIdentity(env: EnvLike): DevAuthUser {
  const externalId = env.DEV_AUTH_USER_ID?.trim() || DEFAULT_DEV_AUTH_USER_ID;
  if (!DEV_AUTH_USER_ID_PATTERN.test(externalId)) {
    throw new Error("DEV_AUTH_USER_ID may contain only letters, digits, '.', '_' and '-'.");
  }
  return { externalId, email: `${externalId}@example.com` };
}

/**
 * The dev user when the bypass is on, `null` when it is off. Throws when it is on
 * outside a local dev process (allowlist: `NODE_ENV=development` and `APP_ENV`
 * unset or `dev`, with `NODE_ENV=test` meaning off), so a deployed process never
 * silently falls back or acts as the dev user.
 */
export function resolveDevAuthUser(env: EnvLike): DevAuthUser | null {
  // Off under test: a developer's `.env` reaches test processes, which aren't deployed.
  if (env.DEV_AUTH_BYPASS !== "1" || env.NODE_ENV === "test") return null;
  if (env.NODE_ENV !== "development" || (env.APP_ENV !== undefined && env.APP_ENV !== "dev")) {
    throw new Error(
      "DEV_AUTH_BYPASS=1 is allowed only with NODE_ENV=development and APP_ENV unset or dev. Unset it in this environment.",
    );
  }
  return devAuthIdentity(env);
}

/**
 * Whether the dev user applies to this request. The `wos-session` cookie was
 * SameSite=Lax, which kept other sites from acting as the user; without it the
 * server must refuse them itself. Fetch metadata alone can't: Chrome sends no
 * `Sec-Fetch-*` on WebSocket handshakes, nor to a plain-HTTP host that DNS
 * rebinding pointed at loopback. So, in order, the request is refused when:
 *
 * 1. its `Host` isn't a local name (`localhost`, `127.0.0.1`, `*.localhost`, `*.ts.net`);
 * 2. it carries an `Origin` that is unparsable (`null` included) or isn't
 *    `meridian.localhost`, `*.meridian.localhost` or `*.ts.net`;
 * 3. `Sec-Fetch-Site` is `cross-site`, unless it is a top-level GET navigation
 *    (what Lax allowed; `dest=document` excludes framing).
 *
 * Node clients (`./mf`, smoke scripts) send no `Origin` or fetch metadata and pass.
 * Residual: the dev proxy rewrites `Host`, so another tailnet's `*.ts.net` origin
 * passes; reaching it takes a page on that tailnet's Funnel that the developer opens.
 */
export function devAuthAppliesToRequest(request: Request): boolean {
  if (!isLocalHost(request.headers.get("host"))) return false;

  const origin = request.headers.get("origin");
  if (origin !== null && !isTrustedOriginHostname(hostnameOf(origin))) return false;

  if (request.headers.get("sec-fetch-site") !== "cross-site") return true;
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  );
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const isTailnet = (hostname: string) => hostname.endsWith(".ts.net");

/** Whether a `Host` header names this machine or a tailnet (`localhost`, `127.0.0.1`, `*.localhost`, `*.ts.net`). */
export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = hostnameOf(`http://${host}`);
  return (
    hostname !== null &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".localhost") ||
      isTailnet(hostname))
  );
}

function isTrustedOriginHostname(hostname: string | null): boolean {
  return (
    hostname !== null &&
    (hostname === "meridian.localhost" ||
      hostname.endsWith(".meridian.localhost") ||
      isTailnet(hostname))
  );
}
