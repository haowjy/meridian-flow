import { devAuthAppliesToRequest, resolveDevAuthUser } from "@meridian/contracts/dev-auth";
import type { UserId } from "@meridian/contracts/runtime";
import { CookieSessionStorage, createAuthService, validateConfig } from "@workos/authkit-session";
import { HTTPError } from "nitro/h3";
import {
  AccountLinkConflictError,
  type ProjectBootstrapRepository,
  type UserRepository,
} from "../domains/projects/index.js";

// keep: WorkOS's default session storage needs a Node request, which Nitro does not give us; split and rejoin on "=" so base64 values survive
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
  projects: ProjectBootstrapRepository;
}

const authkit = createAuthService({
  sessionStorageFactory: (config) => new ApiCookieSessionStorage(config),
});

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
  // keep: raw process.env on purpose (see `@meridian/contracts/dev-auth`), and it throws when the dev bypass is set outside a local dev process
  if (resolveDevAuthUser(process.env)) return;
  await ensureAuthConfig();
}

export async function resolveUser(request: Request): Promise<ResolvedExternalUser | null> {
  const devUser = resolveDevAuthUser(process.env);
  if (devUser) {
    if (!devAuthAppliesToRequest(request)) return null;
    return { ...devUser, name: null, avatarUrl: null };
  }
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
  let userId: UserId;
  try {
    userId = await deps.users.ensureUser({
      externalId: user.externalId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    });
  } catch (error) {
    if (!(error instanceof AccountLinkConflictError)) throw error;
    throw new HTTPError({
      status: 409,
      message:
        "This email is already associated with a different sign-in identity. Sign in with the original account or contact support.",
      data: { code: "account_link_conflict" },
    });
  }

  await deps.projects.ensureDefaultBootstrapReady(userId);

  return userId;
}
