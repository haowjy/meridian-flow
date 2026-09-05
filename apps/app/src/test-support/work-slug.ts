/** Test fixture decoder that fails loudly instead of weakening WorkSlug fields. */
import { decodeWorkSlug, type WorkSlug } from "@meridian/contracts/works";

export function testWorkSlug(value: string): WorkSlug {
  const decoded = decodeWorkSlug(value);
  if (!decoded) throw new Error(`Invalid Work slug fixture: ${value}`);
  return decoded;
}
