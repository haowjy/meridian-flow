import { getRequestHeader, getRequestHost, getRequestProtocol } from "@tanstack/react-start/server";

export function requestFromServerHeaders(): Request | undefined {
  const host = getRequestHost({ xForwardedHost: true }) ?? getRequestHeader("host");
  if (!host) return undefined;

  const protocol = getRequestProtocol({ xForwardedProto: true }) ?? "https";
  const headers = new Headers();
  headers.set("host", host);

  const forwardedHost = getRequestHeader("x-forwarded-host");
  if (forwardedHost) headers.set("x-forwarded-host", forwardedHost);

  const cookie = getRequestHeader("cookie");
  if (cookie) headers.set("cookie", cookie);

  return new Request(`${protocol}://${host}/`, { headers });
}
