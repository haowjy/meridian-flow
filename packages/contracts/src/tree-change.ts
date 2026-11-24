import { z } from "zod";

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
