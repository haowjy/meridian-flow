/**
 * ssr-api-request — builds the API request options used by TanStack Start SSR
 * loaders when they fetch through the server process instead of the browser.
 *
 * Key decision: under portless, Nitro's internal `request.url` can point at the
 * private upstream (`https://127.0.0.1:*`). The public app host is preserved on
 * forwarded headers, so SSR API fetches resolve from configured
 * `MERIDIAN_API_ORIGIN` first, then in dev only the forwarded app host mapped
 * to its paired API host, while preserving the incoming auth cookie for the
 * API auth gate. Production must configure an explicit API origin instead of
 * silently falling back to localhost.
 */
import { getGlobalStartContext } from "@tanstack/react-start";

import { readOptionalEnvString } from "@/core/env";
import {
  resolveApiDevOriginFallback,
  resolveApiDevOriginForAppHost,
} from "@/core/transport/dev-transport";

const TS_NET_SUFFIX = ".ts.net";

type RequestContext = {
  request?: Request;
};

type ApiRequestInit = {
  origin?: string;
  headers?: HeadersInit;
};

// Server-only AppServerConfig is not imported here: this module is isomorphic
// (route loaders import it from client paths) and may run in the browser where
// process.env server vars are undefined. Guarded process.env reads stay local.
function isDevRuntime(): boolean {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return false;
  return (
    import.meta.env.DEV || (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
  );
}

function cookieHeaders(request: Request): HeadersInit | undefined {
  const cookie = request.headers.get("cookie");
  return cookie ? { cookie } : undefined;
}

function firstHeaderValue(value: string | null): string | undefined {
  return value
    ?.split(",")
    .map((part) => part.trim())
    .find(Boolean);
}

function configuredApiOrigin(): string | undefined {
  if (typeof process === "undefined") return undefined;
  // See isDevRuntime — cannot use getAppServerConfig() from this isomorphic module.
  return readOptionalEnvString(process.env.MERIDIAN_API_ORIGIN);
}

function requestUrlHost(request: Request): string | undefined {
  try {
    return new URL(request.url).host;
  } catch {
    return undefined;
  }
}

function publicAppHost(request: Request): string | undefined {
  return (
    firstHeaderValue(request.headers.get("x-forwarded-host")) ??
    firstHeaderValue(request.headers.get("host")) ??
    requestUrlHost(request)
  );
}

function publicAppProtocol(request: Request): "http" | "https" {
  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  if (forwardedProto === "http" || forwardedProto === "https") return forwardedProto;

  try {
    return new URL(request.url).protocol === "http:" ? "http" : "https";
  } catch {
    return "https";
  }
}

function isTailnetHost(appHost: string): boolean {
  const [rawHost] = appHost.toLowerCase().split(":");
  return rawHost?.endsWith(TS_NET_SUFFIX) ?? false;
}

export function resolveSsrApiOrigin(request: Request): string | undefined {
  const configuredOrigin = configuredApiOrigin();
  if (configuredOrigin) return configuredOrigin;

  if (!isDevRuntime()) {
    console.error(
      "MERIDIAN_API_ORIGIN is required for SSR API requests outside local development; skipping SSR API seeding.",
    );
    return undefined;
  }

  const fallback = resolveApiDevOriginFallback();
  const appHost = publicAppHost(request);
  if (!appHost) return fallback;

  // Tailnet dev exposes the app origin and relies on the app dev proxy for /api;
  // there is no stable paired server tailnet host/port for SSR to derive.
  if (isTailnetHost(appHost)) {
    return `${publicAppProtocol(request)}://${appHost}`;
  }

  return resolveApiDevOriginForAppHost(appHost, fallback);
}

export function ssrApiRequestInitFromRequest(request: Request): ApiRequestInit {
  const origin = resolveSsrApiOrigin(request);
  const headers = cookieHeaders(request);
  return {
    ...(origin ? { origin } : {}),
    ...(headers ? { headers } : {}),
  };
}

export function ssrApiRequestInit(): ApiRequestInit | undefined {
  const request = (getGlobalStartContext() as RequestContext | undefined)?.request;
  return request ? ssrApiRequestInitFromRequest(request) : undefined;
}
