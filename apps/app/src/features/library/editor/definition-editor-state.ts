// @ts-nocheck
/**
 * definition-editor-state — pure helpers for Library definition form drafts.
 *
 * Keeps known frontmatter keys editable while unknown YAML keys round-trip on
 * save. Dirty detection compares canonical draft snapshots, not field-by-field
 * references, so nested meta objects stay stable.
 *
 * Skill ordering is definition content (`meta.skills`); `modelInvocable` is
 * operational link state mutated immediately via PATCH, not part of the draft.
 */
import type {
  AgentDefinitionDetail,
  AgentSkillLinkDetail,
  DefinitionMeta,
  SkillDefinitionDetail,
} from "@meridian/contracts/agents";

export const AGENT_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
  "max",
  "disabled",
  "adaptive",
] as const;

export type AgentEffortOption = (typeof AGENT_EFFORT_OPTIONS)[number];

export type AgentEditorDraft = {
  body: string;
  meta: DefinitionMeta;
  config: DefinitionMeta;
};

export type SkillEditorDraft = {
  body: string;
  meta: DefinitionMeta;
};

export function isAgentDefinitionEditable(agent: AgentDefinitionDetail): boolean {
  return agent.source !== "builtin";
}

export function isSkillDefinitionEditable(skill: SkillDefinitionDetail): boolean {
  return skill.source !== "builtin";
}

export function stringMetaValue(meta: DefinitionMeta, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value : "";
}

export function modelFromAgent(agent: AgentDefinitionDetail): string {
  const configModel = stringMetaValue(agent.config, "model");
  if (configModel) return configModel;
  return stringMetaValue(agent.meta, "model");
}

export function effortFromAgent(agent: AgentDefinitionDetail): AgentEffortOption | "" {
  const configEffort = stringMetaValue(agent.config, "effort");
  const metaEffort = stringMetaValue(agent.meta, "effort");
  const raw = (configEffort || metaEffort).toLowerCase();
  return (AGENT_EFFORT_OPTIONS as readonly string[]).includes(raw)
    ? (raw as AgentEffortOption)
    : "";
}

export function skillSlugsFromMeta(meta: DefinitionMeta): string[] {
  const skills = meta.skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter((slug): slug is string => typeof slug === "string");
}

export function orderedSkillLinks(agent: AgentDefinitionDetail): AgentSkillLinkDetail[] {
  const slugs = skillSlugsFromMeta(agent.meta);
  if (slugs.length === 0) {
    return [...agent.skillLinks].sort((left, right) => left.ordinal - right.ordinal);
  }
  const bySlug = new Map(agent.skillLinks.map((link) => [link.skillSlug, link]));
  return slugs
    .map((slug, ordinal) => {
      const link = bySlug.get(slug);
      return (
        link ?? {
          skillSlug: slug,
          ordinal,
          modelInvocable: true,
          userInvocable: null,
        }
      );
    })
    .map((link, ordinal) => ({ ...link, ordinal }));
}

export function agentDraftFromDetail(agent: AgentDefinitionDetail): AgentEditorDraft {
  const meta = structuredClone(agent.meta);
  const linkedSlugs = orderedSkillLinks(agent).map((link) => link.skillSlug);
  if (linkedSlugs.length > 0) {
    meta.skills = linkedSlugs;
  }
  return {
    body: agent.body,
    meta,
    config: structuredClone(agent.config),
  };
}

export function skillDraftFromDetail(skill: SkillDefinitionDetail): SkillEditorDraft {
  return {
    body: skill.body,
    meta: structuredClone(skill.meta),
  };
}

export function applyAgentMetaFields(
  meta: DefinitionMeta,
  fields: { name: string; description: string; model: string; effort: AgentEffortOption | "" },
): DefinitionMeta {
  const next: DefinitionMeta = { ...meta, name: fields.name, description: fields.description };
  if (fields.model.trim()) next.model = fields.model.trim();
  else delete next.model;
  if (fields.effort) next.effort = fields.effort;
  else delete next.effort;
  return next;
}

export function buildAgentSaveRequest(draft: AgentEditorDraft): {
  body: string;
  meta: DefinitionMeta;
  config: DefinitionMeta;
} {
  return {
    body: draft.body,
    meta: draft.meta,
    config: draft.config,
  };
}

export function buildSkillSaveRequest(draft: SkillEditorDraft): {
  body: string;
  meta: DefinitionMeta;
} {
  return {
    body: draft.body,
    meta: draft.meta,
  };
}

export function agentDraftSnapshot(draft: AgentEditorDraft): string {
  return JSON.stringify(buildAgentSaveRequest(draft));
}

export function skillDraftSnapshot(draft: SkillEditorDraft): string {
  return JSON.stringify(buildSkillSaveRequest(draft));
}

export function isAgentDraftDirty(baseline: AgentEditorDraft, draft: AgentEditorDraft): boolean {
  return agentDraftSnapshot(baseline) !== agentDraftSnapshot(draft);
}

export function isSkillDraftDirty(baseline: SkillEditorDraft, draft: SkillEditorDraft): boolean {
  return skillDraftSnapshot(baseline) !== skillDraftSnapshot(draft);
}

export function moveSkillInMeta(
  meta: DefinitionMeta,
  index: number,
  direction: -1 | 1,
): DefinitionMeta {
  const slugs = skillSlugsFromMeta(meta);
  const target = index + direction;
  if (target < 0 || target >= slugs.length) return meta;
  const next = [...slugs];
  const [row] = next.splice(index, 1);
  if (!row) return meta;
  next.splice(target, 0, row);
  return { ...meta, skills: next };
}

export function skillFileSizeLabel(payload: SkillDefinitionDetail["files"][string]): string {
  if (typeof payload === "string") {
    return formatByteCount(new TextEncoder().encode(payload).byteLength);
  }
  const bytes = Math.floor((payload.data.length * 3) / 4);
  return formatByteCount(bytes);
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
