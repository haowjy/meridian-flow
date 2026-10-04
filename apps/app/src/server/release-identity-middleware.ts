import { createMiddleware } from "@tanstack/react-start";

/** Add runtime release identity to every server response for deploy probes. */
export function releaseIdentityMiddleware() {
  return createMiddleware().server(async ({ next }) => {
    const result = await next();
    const headers = new Headers(result.response.headers);
    headers.set("x-meridian-version", process.env.MERIDIAN_VERSION ?? "unknown");
    headers.set("x-meridian-release", process.env.MERIDIAN_RELEASE_SHA ?? "unknown");
    const response = new Response(result.response.body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers,
    });
    return { ...result, response };
  });
}
