// Pass raw process.env; validated env defaults would make a deployed process look local and enable dev auth bypass

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

// Dev auth checks Host then Origin then Sec-Fetch-Site; Chrome omits fetch metadata on WebSocket handshakes and DNS-rebound HTTP hosts
export function devAuthAppliesToRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (!isLocalHost(host)) return false;

  const origin = request.headers.get("origin");
  if (origin !== null && !isTrustedOrigin(origin, host)) return false;

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

// Only the page's own origin passes (the dev proxies forward Host unchanged). Trusting a name would be wrong twice: every dev stack is "localhost", and anyone can serve a page under `*.ts.net`
function isTrustedOrigin(origin: string, host: string | null): boolean {
  return URL.canParse(origin) && new URL(origin).host === host?.toLowerCase();
}
