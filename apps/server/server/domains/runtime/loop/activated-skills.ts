/**
 * Activated-skill metadata carried on a writer's persisted user turn, plus the
 * shared rendering for one activated skill's body.
 *
 * A `/skill` activation stamps the slugs at enqueue; whichever drain first
 * adopts the turn reads them back, loads each body, and persists it as a
 * hidden `system`-role turn chained immediately after the invoking turn
 * (`persistSkillBodies` in orchestrator.ts) -- once, so a later request
 * reproduces the exact bytes an earlier request saw even if the skill's live
 * content changes afterward. The body is never kept request-only: a
 * request-only rendering here would vanish on the next request and break the
 * frozen prefix's Anthropic cache breakpoints (thread AGENTS.md / runtime
 * CONTEXT.md), the same failure notices used to have.
 *
 * The body turn is never a block on the writer's own turn: `UserTurn.tsx`'s
 * `projectUserTurn` (and anything else that reads a user turn's text --
 * chat-feed previews, fork/handoff copies) concatenates every text block of
 * that turn, so a body block placed there would render inside the writer's
 * own bubble. A separate `system`-role turn with `SKILL_BODY_METADATA` is
 * invisible everywhere a `system_update`/`subagent_update` turn already is
 * (`visible-conversation-policy.ts`, the app's `visible-chat-turns.ts`) and
 * is never routed to `UserTurn` in the first place.
 */
import type { JsonValue, Turn } from "@meridian/contracts/threads";

/** One activated skill's loaded body, ready to render onto its hidden body turn. */
export interface ActivatedSkillBody {
  slug: string;
  description: string;
  body: string;
}

/** Metadata stamped on the hidden turn carrying activated skill bodies. */
export const SKILL_BODY_METADATA = { kind: "system_update", section: "skill_body" } as const;

/** True for a turn built from `SKILL_BODY_METADATA` -- structural, not text-prefix, identification. */
export function isSkillBodyTurn(turn: Pick<Turn, "metadata">): boolean {
  const metadata = turn.metadata as { kind?: string; section?: string } | null;
  return (
    metadata?.kind === SKILL_BODY_METADATA.kind && metadata?.section === SKILL_BODY_METADATA.section
  );
}

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

/** Renders every activated skill's body; the text persisted onto the hidden body turn's block. */
export function formatInvokedSkills(skills: readonly ActivatedSkillBody[]): string {
  return skills.map(formatInvokedSkill).join("\n\n");
}

function formatInvokedSkill(skill: ActivatedSkillBody): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return [
    `skill invoked: ${skill.slug}`,
    ...(description ? ["", `description: ${description}`] : []),
    "",
    skill.body,
  ].join("\n");
}
