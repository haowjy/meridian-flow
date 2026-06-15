/**
 * Agent skill link reconciliation from definition frontmatter.
 *
 * Skill ordering is versioned definition content (`meta.skills` order). Link
 * rows are derived from that list on save/restore; `modelInvocable` is
 * operational state preserved across reorder when already set on the link row.
 */
import type { PackageWriteTransaction } from "../ports/package-store.js";
import { stringsAt } from "./helpers.js";
import type { AgentSkillLinkRecord, JsonObject } from "./types.js";

export async function skillLinksFromMetaSkills(
  tx: PackageWriteTransaction,
  projectId: string,
  agentDefinitionId: string,
  meta: JsonObject,
  existingLinks: AgentSkillLinkRecord[] = [],
): Promise<AgentSkillLinkRecord[]> {
  const existingBySkillId = new Map(existingLinks.map((link) => [link.skillId, link]));
  const links: AgentSkillLinkRecord[] = [];
  const seenSkillSlugs = new Set<string>();
  let ordinal = 0;

  for (const skillSlug of stringsAt(meta.skills)) {
    if (seenSkillSlugs.has(skillSlug)) continue;
    seenSkillSlugs.add(skillSlug);

    const skill =
      (await tx.findSkillDefinition(projectId, skillSlug)) ??
      (await tx.findSkillDefinition(null, skillSlug));
    if (!skill) continue;

    const existing = existingBySkillId.get(skill.id);
    links.push({
      agentDefinitionId,
      skillId: skill.id,
      ordinal,
      modelInvocable: existing?.modelInvocable,
      userInvocable: existing?.userInvocable,
    });
    ordinal += 1;
  }

  return links;
}
