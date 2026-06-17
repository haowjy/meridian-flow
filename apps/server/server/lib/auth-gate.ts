/**
 * App-layer authentication gate for Nitro HTTP routes and WebSocket entrypoints.
 *
 * This module is the single seam that combines app composition with WorkOS
 * authentication and user-row provisioning. Keeping that wiring here prevents
 * route handlers from accidentally authenticating a request without ensuring
 * the authenticated user exists in the app database.
 */
import { HTTPError } from "nitro/h3";
import { type AppServices, getApp } from "./app.js";
import type { ResolvedUser } from "./auth.js";
import { provisionAuthenticatedUser, resolveUser } from "./auth.js";

export interface AppUser {
  app: AppServices;
  user: ResolvedUser;
}

export interface AppUserEvent {
  req: Request;
}

export async function requireAppUser(event: AppUserEvent): Promise<AppUser> {
  return requireAppUserFromRequest(event.req);
}

/**
 * Compose app services + authenticate + provision user row.
 *
 * The single gate every route handler passes through. Combines three concerns:
 * 1. Validate the WorkOS session cookie → external user identity (401 if absent)
 * 2. Get the singleton AppServices (lazy init, gateway, DB)
 * 3. Upsert the user row in our DB and ensure a personal project exists → internal UserId
 *
 * Throws 401 if the session is missing or invalid. Throws 500 if user-row
 * provisioning fails (DB unavailable, etc.).
 */
export async function requireAppUserFromRequest(request: Request): Promise<AppUser> {
  const externalUser = await resolveUser(request);
  if (!externalUser) {
    throw new HTTPError({ status: 401, message: "Unauthorized" });
  }

  const app = await getApp();
  const userId = await provisionAuthenticatedUser(externalUser, {
    users: app.users,
    projects: app.projects,
  });
  return { app, user: { ...externalUser, userId } };
}

/**
 * Non-throwing variant for WS upgrade paths.
 *
 * Returns `null` on 401 (missing/invalid session) instead of throwing.
 * All other errors propagate as throws (server misconfiguration, DB failures,
 * etc.). WS upgrade handlers use this to implement accept-then-close auth
 * without crashing the Nitro dev proxy.
 */
export async function resolveAppUserFromRequest(request: Request): Promise<AppUser | null> {
  try {
    return await requireAppUserFromRequest(request);
  } catch (error) {
    if (isUnauthorized(error)) return null;
    throw error;
  }
}

/**
 * Detect a 401/unauthorized error from either H3's HTTPError or a plain
 * object with a `statusCode` property (some non-H3 middleware throws duck-
 * typed errors that carry `.statusCode` but aren't instanceof HTTPError).
 */
function isUnauthorized(error: unknown): boolean {
  if (error instanceof HTTPError) return error.statusCode === 401;
  if (!error || typeof error !== "object") return false;
  const status = "statusCode" in error ? Number(error.statusCode) : undefined;
  return status === 401;
}
