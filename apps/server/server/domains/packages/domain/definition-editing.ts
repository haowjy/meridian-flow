/** Versioned Agent/skill edits and owned restore over complete immutable source snapshots. */
import type {
  AgentDefinitionResponse,
  DefinitionRevisionListResponse,
  PatchAgentSkillLinkRequest,
  SkillDefinitionResponse,
  UpdateAgentDefinitionRequest,
  UpdateSkillDefinitionRequest,
} from "@meridian/contracts/agents";
import type { AgentRevisionStore } from "../ports/agent-revision-store.js";
import { compileAgentDefinition } from "./agent-definition-compiler.js";
import { sha256 } from "./helpers.js";
import {
  canonicalizeJsonObject,
  parseMarkdownDefinition,
  serializeMarkdownDefinition,
} from "./mars-source.js";
import { requireSource } from "./package-management.js";
import { replaceSourceEntity, sourceEntities } from "./package-reconciliation.js";
import { AgentPublicationConflictError, publishAgentSource } from "./source-publication.js";

type Entity = ReturnType<typeof sourceEntities>[number];
export class DefinitionEditError extends Error {}
const checksum = (entity: Entity) => sha256(JSON.stringify(canonicalizeJsonObject(entity)));
const definitionPath = (entity: Entity) =>
  entity.kind === "agent" ? `agents/${entity.slug}.md` : `skills/${entity.slug}/SKILL.md`;
function parsed(entity: Entity) {
  const text = entity.files[definitionPath(entity)];
  if (typeof text !== "string") throw new DefinitionEditError("Definition is not UTF-8 text");
  return parseMarkdownDefinition(text);
}
async function ownedDefinition(
  store: AgentRevisionStore,
  user: string,
  kind: Entity["kind"],
  slug: string,
  includeRetained = false,
) {
  const matches = [];
  for (const installation of await store.listInstallations(user)) {
    const source = await requireSource(store, installation.currentRevisionId);
    let entity = sourceEntities(source).find((item) => item.kind === kind && item.slug === slug);
    if (!entity && includeRetained) {
      for (const row of await store.readInstallationHistory(user, installation.id)) {
        entity = sourceEntities(await requireSource(store, row.packageRevisionId)).find(
          (item) => item.kind === kind && item.slug === slug,
        );
        if (entity) break;
      }
    }
    if (entity) matches.push({ installation, source, entity });
  }
  if (!matches.length) throw new DefinitionEditError(`Unknown owned ${kind}: ${slug}`);
  if (matches.length !== 1) throw new AgentPublicationConflictError(`Ambiguous ${kind}: ${slug}`);
  return matches[0];
}
function agentDetail(entity: Entity, original: Entity | undefined, packageName: string) {
  const { meta, body } = parsed(entity);
  const compiled = compileAgentDefinition({ meta, body, config: entity.config });
  if (!compiled.ok)
    throw new DefinitionEditError(compiled.diagnostics.map((item) => item.message).join("; "));
  const skills = compiled.definition.metadata.skills;
  const available = new Set(skills && "available" in skills ? (skills.available ?? []) : []);
  const all = [...new Set([...(skills?.load ?? []), ...available])];
  return {
    slug: entity.slug,
    meta,
    body,
    config: entity.config ?? {},
    source: "package" as const,
    packageName,
    originalContentChecksum: original ? checksum(original) : null,
    contentChecksum: checksum(entity),
    isEdited: original ? checksum(original) !== checksum(entity) : true,
    skillLinks: all.map((skillSlug, ordinal) => ({
      skillSlug,
      ordinal,
      modelInvocable: available.has(skillSlug),
      userInvocable: null,
    })),
  };
}
function skillDetail(entity: Entity, original: Entity | undefined, packageName: string) {
  const { meta, body } = parsed(entity),
    prefix = `skills/${entity.slug}/`;
  const files = Object.fromEntries(
    Object.entries(entity.files)
      .filter(([name]) => name !== definitionPath(entity))
      .map(([name, file]) => [name.slice(prefix.length), file]),
  );
  return {
    slug: entity.slug,
    meta,
    body,
    files,
    source: "package" as const,
    packageName,
    originalContentChecksum: original ? checksum(original) : null,
    contentChecksum: checksum(entity),
    isEdited: original ? checksum(original) !== checksum(entity) : true,
  };
}
async function edit(
  store: AgentRevisionStore,
  user: string,
  kind: Entity["kind"],
  slug: string,
  transform: (
    entity: Entity,
    owned: Awaited<ReturnType<typeof ownedDefinition>>,
  ) => Promise<Entity>,
  includeRetained = false,
) {
  return store.withCatalogTransaction(user, async () => {
    const owned = await ownedDefinition(store, user, kind, slug, includeRetained);
    const entity = await transform(structuredClone(owned.entity), owned);
    const source = structuredClone(owned.source);
    replaceSourceEntity(source, entity);
    const published = await publishAgentSource({
      store,
      ownerUserId: user,
      source,
      expectedRevisionId: owned.installation.currentRevisionId,
    });
    const original = sourceEntities(
      await requireSource(store, owned.installation.upstreamRevisionId),
    ).find((item) => item.kind === kind && item.slug === slug);
    return {
      entity,
      original,
      packageName: owned.installation.coordinate,
      revisionId: published.packageRevisionId,
    };
  });
}
export async function saveAgentDefinition(
  store: AgentRevisionStore,
  user: string,
  slug: string,
  input: UpdateAgentDefinitionRequest,
): Promise<AgentDefinitionResponse> {
  const saved = await edit(store, user, "agent", slug, async (entity) => ({
    ...entity,
    files: { [definitionPath(entity)]: serializeMarkdownDefinition(input.meta, input.body) },
    ...(input.config !== undefined ? { config: input.config } : {}),
  }));
  return {
    agent: agentDetail(saved.entity, saved.original, saved.packageName),
    revisionId: saved.revisionId,
  };
}
export async function saveSkillDefinition(
  store: AgentRevisionStore,
  user: string,
  slug: string,
  input: UpdateSkillDefinitionRequest,
): Promise<SkillDefinitionResponse> {
  const saved = await edit(store, user, "skill", slug, async (entity) => ({
    ...entity,
    files: {
      ...entity.files,
      [definitionPath(entity)]: serializeMarkdownDefinition(input.meta, input.body),
    },
  }));
  return {
    skill: skillDetail(saved.entity, saved.original, saved.packageName),
    revisionId: saved.revisionId,
  };
}
async function history(
  store: AgentRevisionStore,
  user: string,
  kind: Entity["kind"],
  slug: string,
): Promise<DefinitionRevisionListResponse> {
  const owned = await ownedDefinition(store, user, kind, slug, true);
  const revisions = [];
  for (const row of await store.readInstallationHistory(user, owned.installation.id)) {
    const entity = sourceEntities(await requireSource(store, row.packageRevisionId)).find(
      (item) => item.kind === kind && item.slug === slug,
    );
    if (entity)
      revisions.push({
        id: row.packageRevisionId,
        contentChecksum: checksum(entity),
        createdAt: row.createdAt,
      });
  }
  return { revisions };
}
export const listAgentDefinitionRevisions = (
  store: AgentRevisionStore,
  user: string,
  slug: string,
) => history(store, user, "agent", slug);
export const listSkillDefinitionRevisions = (
  store: AgentRevisionStore,
  user: string,
  slug: string,
) => history(store, user, "skill", slug);
async function restore(
  store: AgentRevisionStore,
  user: string,
  kind: Entity["kind"],
  slug: string,
  revisionId?: string,
) {
  return edit(
    store,
    user,
    kind,
    slug,
    async (_entity, owned) => {
      const id = revisionId ?? owned.installation.upstreamRevisionId;
      const allowed = await store.readInstallationHistory(user, owned.installation.id);
      if (!allowed.some((item) => item.packageRevisionId === id))
        throw new DefinitionEditError("Revision does not belong to this package");
      const target = sourceEntities(await requireSource(store, id)).find(
        (item) => item.kind === kind && item.slug === slug,
      );
      if (!target) throw new DefinitionEditError("Definition is absent from that revision");
      return target;
    },
    true,
  );
}
export async function restoreAgentDefinitionRevision(
  store: AgentRevisionStore,
  user: string,
  slug: string,
  revisionId?: string,
): Promise<AgentDefinitionResponse> {
  const saved = await restore(store, user, "agent", slug, revisionId);
  return {
    agent: agentDetail(saved.entity, saved.original, saved.packageName),
    revisionId: saved.revisionId,
  };
}
export const restoreAgentDefinitionOriginal = (
  store: AgentRevisionStore,
  user: string,
  slug: string,
) => restoreAgentDefinitionRevision(store, user, slug);
export async function restoreSkillDefinitionRevision(
  store: AgentRevisionStore,
  user: string,
  slug: string,
  revisionId?: string,
): Promise<SkillDefinitionResponse> {
  const saved = await restore(store, user, "skill", slug, revisionId);
  return {
    skill: skillDetail(saved.entity, saved.original, saved.packageName),
    revisionId: saved.revisionId,
  };
}
export const restoreSkillDefinitionOriginal = (
  store: AgentRevisionStore,
  user: string,
  slug: string,
) => restoreSkillDefinitionRevision(store, user, slug);

/** The former live link toggle now versions the Agent's explicit loadable-skill declaration. */
export async function patchAgentSkillLink(
  store: AgentRevisionStore,
  user: string,
  slug: string,
  skillSlug: string,
  input: PatchAgentSkillLinkRequest,
) {
  const saved = await edit(store, user, "agent", slug, async (entity) => {
    const { meta, body } = parsed(entity);
    const compiled = compileAgentDefinition({ meta, body, config: entity.config });
    if (!compiled.ok) throw new DefinitionEditError("Agent cannot be compiled");
    const skills = compiled.definition.metadata.skills;
    const load = skills?.load ?? [];
    const available = new Set(skills && "available" in skills ? (skills.available ?? []) : []);
    if (!input.modelInvocable && !load.includes(skillSlug) && !available.has(skillSlug))
      throw new DefinitionEditError("Skill is not declared by this Agent");
    if (input.modelInvocable) available.add(skillSlug);
    else available.delete(skillSlug);
    // Publication resolves enabled references against this source's retained graph.
    const declaration = { ...skills, available: [...available] };
    // A package overlay wins over frontmatter; update the existing authority, not a shadowed field.
    if (entity.config && Object.hasOwn(entity.config, "skills"))
      entity.config = { ...entity.config, skills: declaration };
    else
      entity.files[definitionPath(entity)] = serializeMarkdownDefinition(
        { ...meta, skills: declaration },
        body,
      );
    return entity;
  });
  return agentDetail(saved.entity, saved.original, saved.packageName);
}
