import type { JsonValue, Turn } from "@meridian/contracts/threads";
import { classifyHistoryItem, skillBodyMetadata } from "../../threads/index.js";
import { skillFileHeader } from "./skill-files.js";

export interface ActivatedSkillBody {
  slug: string;
  description: string;
  body: string;
  readable: boolean;
}

export const SKILL_BODY_METADATA = skillBodyMetadata();

export function isSkillBodyTurn(turn: Pick<Turn, "metadata">): boolean {
  return (
    classifyHistoryItem({ role: "system", origin: "system", metadata: turn.metadata }).kind ===
    "skill_body"
  );
}

export function activatedSkillMetadata(slugs: readonly string[]): JsonValue | null {
  return slugs.length > 0 ? { activatedSkillSlugs: [...slugs] } : null;
}

export function readActivatedSkillSlugs(turn: Pick<Turn, "metadata">): string[] {
  const metadata = turn.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const slugs = (metadata as { activatedSkillSlugs?: unknown }).activatedSkillSlugs;
  if (!Array.isArray(slugs)) return [];
  return slugs.filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
}

export function formatInvokedSkills(skills: readonly ActivatedSkillBody[]): string {
  return skills.map(formatInvokedSkill).join("\n\n");
}

function formatInvokedSkill(skill: ActivatedSkillBody): string {
  const description = skill.description.replace(/\s+/g, " ").trim();
  return [
    skill.readable ? skillFileHeader(skill.slug, "SKILL.md") : `skill invoked: ${skill.slug}`,
    ...(description ? ["", `description: ${description}`] : []),
    "",
    skill.body,
  ].join("\n");
}
