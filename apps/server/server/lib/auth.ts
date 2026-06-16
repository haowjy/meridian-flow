/**
 * WorkOS authentication seam: wraps @workos/authkit-session (cookie session
 * storage, requireUser) and resolves an authenticated identity. Owns the auth
 * provider integration; depends inward on the user repository port.
 */
import type { UserId } from "@meridian/contracts/runtime";
import { CookieSessionStorage, createAuthService, validateConfig } from "@workos/authkit-session";
import { HTTPError } from "nitro/h3";
import type { UserRepository } from "../domains/projects/index.js";

/**
 * Custom cookie session storage that manually parses the cookie header.
 *
 * WorkOS's default CookieSessionStorage uses a cookie-parsing library that
 * depends on Node.js HTTP request objects. Our Nitro routes receive Web API
 * `Request` objects, so we bypass the library and parse the cookie header
 * directly. Splitting and rejoining `=` preserves cookie values that contain
 * `=` signs (e.g., base64-encoded payloads).
 */
class ApiCookieSessionStorage extends CookieSessionStorage<Request, Response> {
  async getCookie(request: Request, name: string): Promise<string | null> {
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) return null;

    for (const cookie of cookieHeader.split(";")) {
      const [rawName, ...rawValue] = cookie.trim().split("=");
      if (rawName !== name) continue;

      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }

    return null;
  }
}

export interface ResolvedUser {
  externalId: string;
  userId: UserId;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export type ResolvedExternalUser = Omit<ResolvedUser, "userId">;

export interface UserProvisioningDeps {
  users: UserRepository;
}

const authkit = createAuthService({
  sessionStorageFactory: (config) => new ApiCookieSessionStorage(config),
});

/**
 * Deferred config validation flag.
 *
 * `createAuthService()` is called at module top-level (import time), but
 * WorkOS config must be validated lazily because env vars may not be
 * available until after Nitro's env loading phase. `ensureAuthConfig()`
 * gates `validateConfig()` behind a once flag so it's only called the
 * first time a request triggers auth. No promise or mutex — concurrent
 * callers may double-validate, which is harmless (idempotent check).
 */
let configValidated = false;

async function ensureAuthConfig(): Promise<void> {
  if (configValidated) return;
  await validateConfig();
  configValidated = true;
}

function composeName(firstName: string | null, lastName: string | null): string | null {
  const name = [firstName, lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return name || null;
}

export async function validateAuthConfiguration(): Promise<void> {
  await ensureAuthConfig();
}

export async function resolveUser(request: Request): Promise<ResolvedExternalUser | null> {
  await ensureAuthConfig();
  const { auth } = await authkit.withAuth(request);
  if (!auth.user) return null;

  return {
    externalId: auth.user.id,
    email: auth.user.email,
    name: composeName(auth.user.firstName, auth.user.lastName),
    avatarUrl: auth.user.profilePictureUrl ?? null,
  };
}

export async function provisionAuthenticatedUser(
  user: ResolvedExternalUser,
  deps: UserProvisioningDeps,
): Promise<UserId> {
  return deps.users.ensureUser({
    externalId: user.externalId,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  });
}

export async function requireUser(
  request: Request,
  deps: UserProvisioningDeps,
): Promise<ResolvedUser> {
  const user = await resolveUser(request);
  if (!user) {
    throw new HTTPError({ status: 401, message: "Unauthorized" });
  }
  const userId = await provisionAuthenticatedUser(user, deps);
  return { ...user, userId };
}
