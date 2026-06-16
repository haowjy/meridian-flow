/** App-side current-user resolution from the sealed WorkOS AuthKit session cookie. */
import { getAuth } from "@workos/authkit-tanstack-react-start";

export interface CurrentUser {
  userId: string;
  email: string | null;
}

export async function resolveCurrentUserFromRequest(): Promise<CurrentUser | null> {
  const { user } = await getAuth();
  if (!user) return null;
  return {
    userId: user.id,
    email: user.email ?? null,
  };
}
