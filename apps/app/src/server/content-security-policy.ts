/**
 * The page's content security policy. It sets `img-src` only: Flow draws an image from its own
 * origin (signed storage URLs in dev, and the image proxy a writer's "Load image" click goes
 * through), from the object store's signed URLs, and from `data:` and `blob:`. A remote image
 * the page fetched itself would send the writer's text to its host, so no other origin is listed.
 */
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
