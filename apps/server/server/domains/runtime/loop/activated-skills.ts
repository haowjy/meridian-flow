/**
 * Activated-skill metadata carried on a writer's persisted user turn. A `/skill`
 * activation stamps the slugs at enqueue; the drain that serves the turn reads
 * them back and inlines the bodies (slug, description, body) into that turn's
 * model request. The bodies stay request-only — never persisted as blocks — so
 * the persisted turn remains the one source for the activation.
 */
import type { JsonValue, Turn } from "@meridian/contracts/threads";

/** Stamps the activated slugs as hidden turn metadata; null when none activated. */
export function activatedSkillMetadata(slugs: readonly string[]): JsonValue | null {
  return slugs.length > 0 ? { activatedSkillSlugs: [...slugs] } : null;
}

/** Reads the activated slugs back off a persisted writer turn; [] when none. */
export function readActivatedSkillSlugs(turn: Pick<Turn, "metadata">): string[] {
  const metadata = turn.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const slugs = (metadata as { activatedSkillSlugs?: unknown }).activatedSkillSlugs;
  if (!Array.isArray(slugs)) return [];
  return slugs.filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
}
