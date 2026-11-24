// keep: Pass raw process.env; validated env defaults would make a deployed process look local and enable dev auth bypass

export interface DevAuthUser {
  externalId: string;
  email: string;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_DEV_AUTH_USER_ID = "test";
const DEV_AUTH_USER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function devAuthIdentity(env: EnvLike): DevAuthUser {
  const externalId = env.DEV_AUTH_USER_ID?.trim() || DEFAULT_DEV_AUTH_USER_ID;
  if (!DEV_AUTH_USER_ID_PATTERN.test(externalId)) {
    throw new Error("DEV_AUTH_USER_ID may contain only letters, digits, '.', '_' and '-'.");
  }
  return { externalId, email: `${externalId}@example.com` };
}

export function resolveDevAuthUser(env: EnvLike): DevAuthUser | null {
  if (env.DEV_AUTH_BYPASS !== "1" || env.NODE_ENV === "test") return null;
  if (env.NODE_ENV !== "development" || (env.APP_ENV !== undefined && env.APP_ENV !== "dev")) {
    throw new Error(
      "DEV_AUTH_BYPASS=1 is allowed only with NODE_ENV=development and APP_ENV unset or dev. Unset it in this environment.",
    );
  }
  return devAuthIdentity(env);
}

// keep: Dev auth checks Host then Origin then Sec-Fetch-Site; Chrome omits fetch metadata on WebSocket handshakes and DNS-rebound HTTP hosts
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
