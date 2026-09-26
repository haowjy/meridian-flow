/**
 * Activated-skill metadata carried on a writer's persisted user turn, plus the
 * shared rendering for one activated skill's body.
 *
 * A `/skill` activation stamps the slugs at enqueue; whichever drain first
 * adopts the turn reads them back, loads each body, and persists it as a
 * durable block on that same turn (`persistSkillBodies` in orchestrator.ts) --
 * once, so a later request reproduces the exact bytes an earlier request saw
 * even if the skill's live content changes afterward. The body is never kept
 * request-only: a request-only rendering here would vanish on the next
 * request and break the frozen prefix's Anthropic cache breakpoints (thread
 * AGENTS.md / runtime CONTEXT.md), the same failure notices used to have.
 */
import type { JsonValue, Turn } from "@meridian/contracts/threads";

/** One activated skill's loaded body, ready to render onto its invoking turn. */
export interface ActivatedSkillBody {
  slug: string;
  description: string;
  body: string;
}

/** Identifies an already-persisted skill-body block so a retried drain never double-persists. */
export const SKILL_BODY_BLOCK_MARKER = "skill invoked:";

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

/** Renders one activated skill's body; the text persisted onto its invoking turn's block. */
export function formatInvokedSkill(skill: ActivatedSkillBody): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return [
    `${SKILL_BODY_BLOCK_MARKER} ${skill.slug}`,
    ...(description ? ["", `description: ${description}`] : []),
    "",
    skill.body,
  ].join("\n");
}
