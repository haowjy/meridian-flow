// In-memory PackageRepository adapter: hermetic package persistence for tests and local composition.
import { randomUUID } from "node:crypto";

import { agentModeFromMeta } from "../domain/mars-source.js";
import { resolveAgentSkills } from "../domain/resolution.js";
import type {
  AgentDefinitionRecord,
  AgentDefinitionRevisionRecord,
  AgentSkillLinkRecord,
  PackageInstallRecord,
  SkillDefinitionRevisionRecord,
  SkillRecord,
  UserInstalledSkillRecord,
} from "../domain/types.js";
import type { PackageRepository, PackageWriteTransaction } from "../ports/package-store.js";

export interface InMemoryPackageStoreSeed {
  packages?: PackageInstallRecord[];
  agents?: AgentDefinitionRecord[];
  skills?: SkillRecord[];
  userSkills?: UserInstalledSkillRecord[];
  agentSkills?: AgentSkillLinkRecord[];
  agentRevisions?: AgentDefinitionRevisionRecord[];
  skillRevisions?: SkillDefinitionRevisionRecord[];
}

export interface InMemoryPackageStore extends PackageRepository {
  dump(): Required<InMemoryPackageStoreSeed>;
}

export function createInMemoryPackageStore(
  seed: InMemoryPackageStoreSeed = {},
): InMemoryPackageStore {
  const state: Required<InMemoryPackageStoreSeed> = {
    packages: [...(seed.packages ?? [])],
    agents: [...(seed.agents ?? [])],
    skills: [...(seed.skills ?? [])],
    userSkills: [...(seed.userSkills ?? [])],
    agentSkills: [...(seed.agentSkills ?? [])],
    agentRevisions: [...(seed.agentRevisions ?? [])],
    skillRevisions: [...(seed.skillRevisions ?? [])],
  };

  return {
    async findPackageInstall(projectId, packageName) {
      return state.packages.find(
        (pkg) => pkg.projectId === projectId && pkg.packageName === packageName,
      );
    },
    async transaction(fn) {
      const snapshot = cloneState(state);
      const tx = createTransaction(snapshot);
      const result = await fn(tx);
      state.packages = snapshot.packages;
      state.agents = snapshot.agents;
      state.skills = snapshot.skills;
      state.userSkills = snapshot.userSkills;
      state.agentSkills = snapshot.agentSkills;
      state.agentRevisions = snapshot.agentRevisions;
      state.skillRevisions = snapshot.skillRevisions;
      return result;
    },
    async getAgentWithLinkedSkills(projectId, userId, agentSlug) {
      const tx = createTransaction(cloneState(state));
      return resolveAgentSkills(tx, projectId, userId, agentSlug);
    },
    dump() {
      return cloneState(state);
    },
  };
}

function createTransaction(state: Required<InMemoryPackageStoreSeed>): PackageWriteTransaction {
  return {
    async findPackageInstall(projectId, packageName) {
      return state.packages.find(
        (pkg) => pkg.projectId === projectId && pkg.packageName === packageName,
      );
    },
    async createPackageInstall(input) {
      const record = { id: nextId("pkg"), ...input };
      state.packages.push(record);
      return record;
    },
    async updatePackageInstall(id, input) {
      Object.assign(
        required(
          state.packages.find((pkg) => pkg.id === id),
          id,
        ),
        input,
      );
    },
    async findAgentBySlug(projectId, slug) {
      return state.agents.find(
        (agent) => agent.projectId === projectId && agent.slug === slug && agent.enabled,
      );
    },
    async findAgentDefinition(projectId, slug) {
      return this.findAgentDefinitionAnyState(projectId, slug);
    },
    async findAgentDefinitionAnyState(projectId, slug) {
      return state.agents.find((agent) => agent.projectId === projectId && agent.slug === slug);
    },
    async listSelectableAgents(projectId) {
      return state.agents.filter(
        (agent) =>
          agent.projectId === projectId &&
          agent.enabled &&
          agentModeFromMeta(agent.meta) === "primary",
      );
    },
    async listProjectAgentDefinitions(projectId) {
      return state.agents.filter((agent) => agent.projectId === projectId);
    },
    async listPackageInstalls(projectId) {
      return state.packages.filter((pkg) => pkg.projectId === projectId);
    },
    async listPackageAgents(packageInstallId) {
      return state.agents.filter((agent) => agent.packageInstallId === packageInstallId);
    },
    async createAgentDefinition(input) {
      const record = { id: nextId("agent"), ...input };
      state.agents.push(record);
      return record;
    },
    async updateAgentDefinition(id, input) {
      Object.assign(
        required(
          state.agents.find((agent) => agent.id === id),
          id,
        ),
        input,
      );
    },
    async deleteAgentDefinition(id) {
      state.agents = state.agents.filter((agent) => agent.id !== id);
      state.agentSkills = state.agentSkills.filter((link) => link.agentDefinitionId !== id);
    },
    async findSkillBySlug(projectId, slug) {
      return state.skills.find(
        (skill) => skill.projectId === projectId && skill.slug === slug && skill.enabled,
      );
    },
    async findSkillDefinition(projectId, slug) {
      return this.findSkillDefinitionAnyState(projectId, slug);
    },
    async findSkillDefinitionAnyState(projectId, slug) {
      return state.skills.find((skill) => skill.projectId === projectId && skill.slug === slug);
    },
    async appendAgentDefinitionRevision(input) {
      const record: AgentDefinitionRevisionRecord = {
        id: nextId("agent_rev"),
        createdAt: new Date().toISOString(),
        ...input,
      };
      state.agentRevisions.push(record);
      return record;
    },
    async listAgentDefinitionRevisions(agentDefinitionId) {
      return state.agentRevisions
        .filter((revision) => revision.agentDefinitionId === agentDefinitionId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async findAgentDefinitionRevision(id) {
      return state.agentRevisions.find((revision) => revision.id === id);
    },
    async appendSkillDefinitionRevision(input) {
      const record: SkillDefinitionRevisionRecord = {
        id: nextId("skill_rev"),
        createdAt: new Date().toISOString(),
        ...input,
      };
      state.skillRevisions.push(record);
      return record;
    },
    async listSkillDefinitionRevisions(skillId) {
      return state.skillRevisions
        .filter((revision) => revision.skillId === skillId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async findSkillDefinitionRevision(id) {
      return state.skillRevisions.find((revision) => revision.id === id);
    },
    async findSkillById(id) {
      const skill = state.skills.find((entry) => entry.id === id);
      return skill?.enabled ? skill : undefined;
    },
    async listPackageSkills(packageInstallId) {
      return state.skills.filter((skill) => skill.packageInstallId === packageInstallId);
    },
    async listProjectSkills(projectId) {
      return state.skills.filter((skill) => skill.projectId === projectId && skill.enabled);
    },
    async listProjectSkillDefinitions(projectId) {
      return state.skills.filter((skill) => skill.projectId === projectId);
    },
    async listUserInstalledSkills(userId) {
      return state.userSkills.filter((skill) => skill.userId === userId && skill.enabled);
    },
    async createSkill(input) {
      const record = { id: nextId("skill"), ...input };
      state.skills.push(record);
      return record;
    },
    async updateSkill(id, input) {
      Object.assign(
        required(
          state.skills.find((skill) => skill.id === id),
          id,
        ),
        input,
      );
    },
    async deleteSkill(id) {
      state.skills = state.skills.filter((skill) => skill.id !== id);
      state.agentSkills = state.agentSkills.filter((link) => link.skillId !== id);
    },
    async linkAgentSkill(input) {
      if (
        !state.agentSkills.some(
          (link) =>
            link.agentDefinitionId === input.agentDefinitionId && link.skillId === input.skillId,
        )
      ) {
        state.agentSkills.push(input);
      }
    },
    async replaceAgentSkillLinks(agentDefinitionId, links) {
      state.agentSkills = state.agentSkills.filter(
        (link) => link.agentDefinitionId !== agentDefinitionId,
      );
      state.agentSkills.push(...uniqueAgentSkillLinks(links));
    },
    async updateAgentSkillLinkModelInvocable(agentDefinitionId, skillId, modelInvocable) {
      const link = state.agentSkills.find(
        (row) => row.agentDefinitionId === agentDefinitionId && row.skillId === skillId,
      );
      if (!link) {
        throw new Error(`Agent skill link not found: ${agentDefinitionId}/${skillId}`);
      }
      link.modelInvocable = modelInvocable;
    },
    async listAgentSkillLinks(agentDefinitionId) {
      return state.agentSkills
        .filter((link) => link.agentDefinitionId === agentDefinitionId)
        .sort(compareAgentSkillLinks);
    },
  };
}

function compareAgentSkillLinks(a: AgentSkillLinkRecord, b: AgentSkillLinkRecord): number {
  return (a.ordinal ?? 0) - (b.ordinal ?? 0);
}

function uniqueAgentSkillLinks(links: AgentSkillLinkRecord[]): AgentSkillLinkRecord[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.agentDefinitionId}:${link.skillId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneState(state: Required<InMemoryPackageStoreSeed>): Required<InMemoryPackageStoreSeed> {
  return {
    packages: state.packages.map((pkg) => ({ ...pkg })),
    agents: state.agents.map((agent) => ({
      ...agent,
      meta: { ...agent.meta },
      config: { ...agent.config },
    })),
    skills: state.skills.map((skill) => ({
      ...skill,
      meta: { ...skill.meta },
      files: { ...skill.files },
    })),
    userSkills: state.userSkills.map((skill) => ({
      ...skill,
      meta: { ...skill.meta },
      files: { ...skill.files },
    })),
    agentSkills: state.agentSkills.map((link) => ({ ...link })),
    agentRevisions: state.agentRevisions.map((revision) => ({
      ...revision,
      meta: { ...revision.meta },
      config: { ...revision.config },
    })),
    skillRevisions: state.skillRevisions.map((revision) => ({
      ...revision,
      meta: { ...revision.meta },
      files: { ...revision.files },
    })),
  };
}

function required<T>(value: T | undefined, id: string): T {
  if (!value) throw new Error(`Record not found: ${id}`);
  return value;
}

function nextId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
