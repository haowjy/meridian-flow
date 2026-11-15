/**
 * The page's content security policy. It sets `img-src` only: Flow draws an image from its own
 * origin (signed storage URLs in dev, and the image proxy a writer's "Load image" click goes
 * through), from the object store's signed URLs, and from `data:` and `blob:`. A remote image
 * the page fetched itself would send the writer's text to its host, so no other origin is listed.
 */
import { createMiddleware } from "@tanstack/react-start";

type PolicyEnv = Record<string, string | undefined>;

/** Where signed read URLs point when the object store is S3-compatible; the local store signs same-origin paths. */
function storageOrigins(env: PolicyEnv): string[] {
  const configured = env.S3_PUBLIC_ENDPOINT?.trim() || env.S3_ENDPOINT?.trim();
  const provider =
    env.OBJECT_STORE_PROVIDER?.trim() || (env.MERIDIAN_BACKENDS === "live" ? "s3" : "local");
  if (provider !== "s3") return [];
  const region = env.S3_REGION?.trim() || "us-east-1";
  const origin = URL.canParse(configured ?? "")
    ? new URL(configured as string)
    : new URL(`https://s3.${region}.amazonaws.com`);
  const host = origin.host;
  // Virtual-hosted style signs `<bucket>.<host>` instead.
  return env.S3_FORCE_PATH_STYLE === "false"
    ? [origin.origin, `${origin.protocol}//*.${host}`]
    : [origin.origin];
}

export function contentSecurityPolicy(env: PolicyEnv = process.env): string {
  return ["img-src 'self' data: blob:", ...storageOrigins(env)].join(" ");
}

export function contentSecurityPolicyMiddleware() {
  const policy = contentSecurityPolicy();
  return createMiddleware().server(async (args) => {
    const result = await args.next();
    result.response.headers.set("Content-Security-Policy", policy);
    return result;
  });
}
