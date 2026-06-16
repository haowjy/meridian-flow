/**
 * Idempotent dev `public.users` seed for `pnpm bootstrap`.
 * Maps the fixed WorkOS dev login (`WORKOS_DEV_LOGIN_USER_ID`) to a deterministic
 * internal Meridian user id; `UserRepository.ensureUser` reconciles on first login.
 */

/** Fixed internal id — never overlaps DB test fixtures (`…0111`, `…0112`). */
export const DEV_BOOTSTRAP_USER_ID = "00000000-0000-4000-8000-000000000010";

export type SeedDevUserInput = {
  databaseUrl: string;
  externalId: string;
  email: string;
  internalId?: string;
};

/** Upsert dev user by `external_id`; returns the internal `public.users.id`. */
export async function seedDevUser(input: SeedDevUserInput): Promise<string> {
  const internalId = input.internalId ?? DEV_BOOTSTRAP_USER_ID;
  const { default: postgres } = await import("postgres");
  const sql = postgres(input.databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO public.users (
        id, external_id, email, created_at, updated_at
      )
      VALUES (
        ${internalId}::uuid, ${input.externalId}, ${input.email}, now(), now()
      )
      ON CONFLICT (external_id) DO UPDATE
      SET email = EXCLUDED.email, updated_at = now()
      RETURNING id::text
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("seedDevUser did not return an internal user id");
    return id;
  } finally {
    await sql.end();
  }
}
