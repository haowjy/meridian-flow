import { waitlistEmails } from "~/server/db/schema";

export async function saveWaitlistEmail(email: string): Promise<void> {
  const { getDb } = await import("~/server/db/client");
  const db = getDb();

  await db
    .insert(waitlistEmails)
    .values({ email })
    .onConflictDoNothing({ target: waitlistEmails.email });
}
