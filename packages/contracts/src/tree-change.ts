/** The removal identity the Trash screen and the server share. */
import { z } from "zod";

/** A removal as the row held it right after: its time and the `location_version` it wrote. */
export const removalIdentitySchema = z.object({
  time: z.string().datetime({ offset: true }),
  locationVersion: z.string().regex(/^(0|[1-9]\d*)$/),
});
export type RemovalIdentity = z.infer<typeof removalIdentitySchema>;
export function serializeRemovalIdentity(input: {
  time: Date;
  locationVersion: bigint;
}): RemovalIdentity {
  return { time: input.time.toISOString(), locationVersion: input.locationVersion.toString() };
}
