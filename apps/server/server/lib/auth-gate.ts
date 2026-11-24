import { EXPECTED_ACCOUNT_HEADER, WRONG_ACCOUNT_CODE } from "@meridian/contracts/commands";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { HTTPError } from "nitro/h3";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
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

// keep: `x-meridian-account` naming another account is a 409 before anything runs, so a sender outliving a sign-in switch cannot act for the new account; WS upgrades and /api/auth/me carry no header and do not come here
export async function requireAppUser(event: AppUserEvent): Promise<AppUser> {
  const signedIn = await requireAppUserFromRequest(event.req);
  const expected = event.req.headers.get(EXPECTED_ACCOUNT_HEADER);
  if (expected !== null && expected !== signedIn.user.userId)
    return throwHttpInterrupt(
      meridianErrorFromSystem(
        WRONG_ACCOUNT_CODE,
        "This request was sent for another account",
        false,
      ),
      409,
    );
  return signedIn;
}

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
