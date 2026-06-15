/**
 * Agent skill-resolution algorithm: merges builtin, user, global-project, and
 * agent-linked skills by slug and sorts them by type. Lives in the domain layer
 * so both repository adapters call it instead of duplicating the logic; runs
 * against an open transaction-shaped read surface.
 */
import type { PackageWriteTransaction } from "../ports/package-store.js";
import { booleanAt, stringAt } from "./helpers.js";
import type {
  ResolvedPackageContext,
  ResolvedSkill,
  SkillRecord,
  UserInstalledSkillRecord,
} from "./types.js";

const SKILL_TYPE_ORDER: Record<string, number> = {
  principle: 0,
  guardrail: 1,
  reference: 2,
};

/**
 * Core resolution algorithm. Runs against an open transaction (or
 * transaction-shaped read surface). The algorithm itself is unchanged —
 * builtin skills, user skills, global project skills, agent-linked skills,
 * merged by slug, sorted by type.
 *
 * **Merge order IS the precedence.** Each layer calls `addResolvedSkill`
 * which overwrites by slug (Map.set). Later layers win by slug:
 *
 *   1. builtin (global/system skills, projectId IS NULL)
 *   2. user-installed (per-user skills)
 *   3. project-global (per-project skills where isGlobal=true)
 *   4. agent-linked (skills explicitly linked to this agent)
 *
 * Within the agent-linked layer, `link.modelInvocable`/`userInvocable`
 * override the skill's own meta — the `??` chain falls back to the skill
 * when the link doesn't specify.
 *
 * Final sort: principle (0) → guardrail (1) → reference (2).
 *
 * Repository adapters call this from their `getAgentWithLinkedSkills`
 * implementation so the logic lives in the domain layer, not duplicated
 * per adapter.
 */
export async function resolveAgentSkills(
  tx: PackageWriteTransaction,
  projectId: string,
  userId: string,
  agentSlug: string,
): Promise<ResolvedPackageContext> {
  const builtinAgent = await tx.findAgentBySlug(null, agentSlug);
  const projectAgent = await tx.findAgentBySlug(projectId, agentSlug);
  const agent = projectAgent ?? builtinAgent;
  const merged = new Map<string, ResolvedSkill>();

  for (const skill of await tx.listProjectSkills(null)) {
    addResolvedSkill(merged, skill.slug, {
      skill,
      layer: "builtin",
      modelInvocable: skillModelInvocable(skill),
      userInvocable: skillUserInvocable(skill),
    });
  }

  for (const skill of await tx.listUserInstalledSkills(userId)) {
    addResolvedSkill(merged, skill.slug, {
      skill,
      layer: "user",
      modelInvocable: skillModelInvocable(skill),
      userInvocable: skillUserInvocable(skill),
    });
  }

  for (const skill of await tx.listProjectSkills(projectId)) {
    if (skillIsGlobal(skill)) {
      addResolvedSkill(merged, skill.slug, {
        skill,
        layer: "project",
        modelInvocable: skillModelInvocable(skill),
        userInvocable: skillUserInvocable(skill),
      });
    }
  }

  if (agent) {
    for (const link of await tx.listAgentSkillLinks(agent.id)) {
      const linkedSkill = await tx.findSkillById(link.skillId);
      if (linkedSkill) {
        addResolvedSkill(merged, linkedSkill.slug, {
          skill: linkedSkill,
          layer: linkedSkill.projectId ? "project" : "builtin",
          modelInvocable: link.modelInvocable ?? skillModelInvocable(linkedSkill),
          userInvocable: link.userInvocable ?? skillUserInvocable(linkedSkill),
        });
      }
    }
  }

  return { agent, skills: [...merged.values()].sort(compareResolvedSkills) };
}

function skillIsGlobal(skill: SkillRecord): boolean {
  return booleanAt(skill.meta.isGlobal) ?? false;
}

function skillModelInvocable(skill: SkillRecord | UserInstalledSkillRecord): boolean {
  return booleanAt(skill.meta.modelInvocable) ?? true;
}

function skillUserInvocable(skill: SkillRecord | UserInstalledSkillRecord): boolean {
  return booleanAt(skill.meta.userInvocable) ?? true;
}

function addResolvedSkill(
  skills: Map<string, ResolvedSkill>,
  slug: string,
  skill: ResolvedSkill,
): void {
  skills.set(slug, skill);
}

function compareResolvedSkills(a: ResolvedSkill, b: ResolvedSkill): number {
  const aType = stringAt(a.skill.meta.type) ?? "reference";
  const bType = stringAt(b.skill.meta.type) ?? "reference";
  return (SKILL_TYPE_ORDER[aType] ?? 2) - (SKILL_TYPE_ORDER[bType] ?? 2);
}
