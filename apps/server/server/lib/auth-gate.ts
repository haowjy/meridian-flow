import { HTTPError } from "nitro/h3";
import { type AppServices, getApp } from "./app.js";
import { type ResolvedUser, requireUser } from "./auth.js";

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

export async function requireAppUserFromRequest(request: Request): Promise<AppUser> {
  const user = await requireUser(request);
  const app = await getApp();
  return { app, user };
}

export async function resolveAppUserFromRequest(request: Request): Promise<AppUser | null> {
  try {
    return await requireAppUserFromRequest(request);
  } catch (error) {
    if (isUnauthorized(error)) return null;
    throw error;
  }
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof HTTPError) return error.statusCode === 401;
  if (!error || typeof error !== "object") return false;
  const status = "statusCode" in error ? Number(error.statusCode) : undefined;
  return status === 401;
}
