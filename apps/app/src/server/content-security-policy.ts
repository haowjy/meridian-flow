// keep: img-src allows no other origin: a remote image would send the writer's text to its host
import { objectStoreConfig, objectStoreReadOrigins } from "@meridian/contracts/object-store-env";
import { createMiddleware } from "@tanstack/react-start";

export function contentSecurityPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return ["img-src 'self' data: blob:", ...objectStoreReadOrigins(objectStoreConfig(env))].join(
    " ",
  );
}

export function contentSecurityPolicyMiddleware() {
  const policy = contentSecurityPolicy();
  return createMiddleware().server(async (args) => {
    const result = await args.next();
    result.response.headers.set("Content-Security-Policy", policy);
    return result;
  });
}
