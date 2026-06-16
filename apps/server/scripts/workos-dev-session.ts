/**
 * Mint a sealed WorkOS AuthKit session cookie for server smoke scripts.
 * Mirrors `apps/app/src/routes/api/auth/dev-login.tsx` (password auth + sealData).
 */
import { getConfig, getWorkOS, sessionEncryption, validateConfig } from "@workos/authkit-session";

const WOS_SESSION_COOKIE = "wos-session";

export type WorkOsDevSession = {
  cookieHeader: string;
  externalUserId: string;
};

function readDevLoginCredentials(): { email: string; password: string } {
  const email = process.env.WORKOS_DEV_LOGIN_EMAIL?.trim() || process.env.TEST_USER_EMAIL?.trim();
  const password =
    process.env.WORKOS_DEV_LOGIN_PASSWORD?.trim() || process.env.TEST_USER_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error(
      "WORKOS_DEV_LOGIN_EMAIL/PASSWORD (or TEST_USER_EMAIL/PASSWORD) are required for smoke auth",
    );
  }
  return { email, password };
}

export async function mintWorkOsDevSession(): Promise<WorkOsDevSession> {
  await validateConfig();
  const clientId = getConfig("clientId");
  const cookiePassword = getConfig("cookiePassword");
  const { email, password } = readDevLoginCredentials();

  const workos = getWorkOS();
  const { user, accessToken, refreshToken, impersonator } =
    await workos.userManagement.authenticateWithPassword({
      clientId,
      email,
      password,
    });

  const sealed = await sessionEncryption.sealData(
    { user, accessToken, refreshToken, impersonator },
    { password: cookiePassword, ttl: 0 },
  );

  return {
    cookieHeader: `${WOS_SESSION_COOKIE}=${sealed}`,
    externalUserId: user.id,
  };
}

export function cookieAuthHeaders(session: WorkOsDevSession): Record<string, string> {
  return { Cookie: session.cookieHeader };
}

/** Resolve internal `public.users.id` for the dev WorkOS external id (post-bootstrap). */
export async function resolveDevInternalUserId(
  databaseUrl: string,
  externalUserId: string,
): Promise<string> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM public.users WHERE external_id = ${externalUserId} LIMIT 1
    `;
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(
        `No public.users row for external_id=${externalUserId}; run pnpm bootstrap first`,
      );
    }
    return id;
  } finally {
    await sql.end();
  }
}
