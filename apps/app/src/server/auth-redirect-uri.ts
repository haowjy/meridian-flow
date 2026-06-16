import { getAppServerConfig } from "./config";

const CALLBACK_PATH = "/api/auth/callback";

/**
 * Resolve the OAuth redirect URI for the current request.
 *
 * In development, sign-in and callback can follow the request origin for
 * portless (`*.localhost`) and Tailscale (`*.ts.net`) when the scheme matches
 * `WORKOS_REDIRECT_URI` (session cookies use that config for the Secure flag).
 * Plain `http://localhost` only participates when the env redirect is also http.
 */
export function resolveAuthRedirectUri(request: Request): string {
  const { runtime, workosRedirectUri: fallback } = getAppServerConfig();
  if (!fallback) {
    throw new Error(
      "WORKOS_REDIRECT_URI is required. Set it in the repo root .env (see .env.example).",
    );
  }
  if (runtime.appEnv !== "dev") return fallback;
  const requestUrl = new URL(request.url);
  const fallbackUrl = new URL(fallback);
  if (!canUseDynamicRedirect(requestUrl, fallbackUrl)) return fallback;
  return `${requestUrl.origin}${CALLBACK_PATH}`;
}

function canUseDynamicRedirect(requestUrl: URL, fallbackUrl: URL): boolean {
  if (requestUrl.protocol !== fallbackUrl.protocol) return false;
  const hostname = requestUrl.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return fallbackUrl.hostname === "localhost" || fallbackUrl.hostname === "127.0.0.1";
  }
  if (hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".ts.net")) return true;
  return false;
}
