import { getGlobalStartContext } from "@tanstack/react-start";

import { readOptionalEnvString } from "@/core/env";

type RequestContext = {
  request?: Request;
};

type ApiRequestInit = {
  origin?: string;
  headers?: HeadersInit;
};

function cookieHeaders(request: Request): HeadersInit | undefined {
  const cookie = request.headers.get("cookie");
  return cookie ? { cookie } : undefined;
}

// Server-only AppServerConfig is not imported here: this module is isomorphic
// (route loaders import it from client paths) and may run in the browser where
// process.env server vars are undefined.
export function resolveSsrApiOrigin(): string | undefined {
  const origin =
    typeof process === "undefined"
      ? undefined
      : readOptionalEnvString(process.env.MERIDIAN_API_ORIGIN);
  if (!origin) {
    console.error(
      "MERIDIAN_API_ORIGIN is required for SSR API requests; skipping SSR API seeding.",
    );
  }
  return origin;
}

export function ssrApiRequestInitFromRequest(request: Request): ApiRequestInit {
  const origin = resolveSsrApiOrigin();
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
