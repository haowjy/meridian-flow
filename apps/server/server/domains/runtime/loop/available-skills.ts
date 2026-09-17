/** Available skill union, body load, and Send-slug authorization for a primary chat. */
import type { RetainedSkillReference } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import {
  type AccountSkillInstallStore,
  type AgentRevisionStore,
  type BoundAgentRevision,
  resolveAgentDependencies,
  type SkillListing,
  skillListingFromMarkdown,
} from "../../packages/index.js";

const SKILL_MD_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

export interface AvailableSkillListing {
  slug: string;
  name: string;
  description: string;
}

export class SkillUnavailableError extends Error {
  readonly name = "SkillUnavailableError";

  constructor(slug: string) {
    super(`Skill "${slug}" is not available`);
  }
}

export function unionAvailableSkills(
  agentSkills: readonly AvailableSkillListing[],
  accountSkills: readonly AvailableSkillListing[],
): AvailableSkillListing[] {
  const seen = new Set<string>();
  const result: AvailableSkillListing[] = [];
  for (const skill of [...agentSkills, ...accountSkills]) {
    if (seen.has(skill.slug)) continue;
    seen.add(skill.slug);
    result.push(skill);
  }
  return result;
}

export async function resolveThreadAvailableSkills(input: {
  thread: Thread;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<AvailableSkillListing[]> {
  if (input.thread.kind !== "primary") return [];
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  const agentSkills = binding
    ? await listAvailableSkillsFromReferences(
        input.agentRevisions,
        binding.configuration.skills.available,
      )
    : [];
  return unionAvailableSkills(
    agentSkills,
    await listAccountAvailableSkills(input.accountSkillInstalls, input.thread.userId),
  );
}

/** Home / creation composer: selected Agent revision ∪ account installs, no thread yet. */
export async function resolveSelectionAvailableSkills(input: {
  userId: string;
  catalogEntryId: string;
  definitionRevisionId: string;
  projectId?: string;
  agentRevisions: Pick<
    AgentRevisionStore,
    "readSelection" | "readSource" | "readPackageDefinitions"
  >;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<AvailableSkillListing[] | null> {
  const selected = await input.agentRevisions.readSelection(
    input.userId,
    input.catalogEntryId,
    input.definitionRevisionId,
    input.projectId,
  );
  if (!selected) return null;
  const dependencies = await resolveAgentDependencies({
    revision: selected.revision,
    store: input.agentRevisions,
  });
  return unionAvailableSkills(
    await listAvailableSkillsFromReferences(input.agentRevisions, dependencies.skills.available),
    await listAccountAvailableSkills(input.accountSkillInstalls, input.userId),
  );
}

export function unavailableActivatedSkillSlugs(
  available: readonly AvailableSkillListing[],
  requested: readonly string[],
): string[] {
  const allowed = new Set(available.map((skill) => skill.slug));
  return requested.filter((slug) => !allowed.has(slug));
}

export async function loadAvailableSkillBody(input: {
  thread: Thread;
  slug: string;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<SkillListing> {
  if (input.thread.kind === "primary") {
    const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
    if (binding) {
      const agentSkill = await readBoundAvailableSkill(input.agentRevisions, binding, input.slug);
      if (agentSkill) return agentSkill;
    }
    const accountSkill = (await input.accountSkillInstalls.listByOwner(input.thread.userId)).find(
      (row) => row.slug === input.slug,
    );
    if (accountSkill) {
      return {
        slug: accountSkill.slug,
        name: accountSkill.name,
        description: accountSkill.description,
        body: accountSkill.body,
      };
    }
  }
  throw new SkillUnavailableError(input.slug);
}

async function listAccountAvailableSkills(
  installs: Pick<AccountSkillInstallStore, "listByOwner">,
  ownerUserId: string,
): Promise<AvailableSkillListing[]> {
  return (await installs.listByOwner(ownerUserId)).map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
  }));
}

async function listAvailableSkillsFromReferences(
  store: Pick<AgentRevisionStore, "readSource">,
  available: readonly RetainedSkillReference[],
): Promise<AvailableSkillListing[]> {
  const listings: AvailableSkillListing[] = [];
  for (const reference of available) {
    const listing = await listingFromBoundReference(store, reference);
    listings.push({
      slug: listing.slug,
      name: listing.name,
      description: listing.description,
    });
  }
  return listings;
}

async function readBoundAvailableSkill(
  store: Pick<AgentRevisionStore, "readSource">,
  binding: BoundAgentRevision,
  slug: string,
): Promise<SkillListing | undefined> {
  for (const reference of binding.configuration.skills.available) {
    const match = SKILL_MD_PATH.exec(reference.path);
    if (!match) {
      throw new Error(`Retained skill path is not a SKILL.md file: ${reference.path}`);
    }
    if (match[1] !== slug) continue;
    return listingFromBoundReference(store, reference);
  }
  return undefined;
}

async function listingFromBoundReference(
  store: Pick<AgentRevisionStore, "readSource">,
  reference: BoundAgentRevision["configuration"]["skills"]["available"][number],
): Promise<SkillListing> {
  const match = SKILL_MD_PATH.exec(reference.path);
  if (!match) {
    throw new Error(`Retained skill path is not a SKILL.md file: ${reference.path}`);
  }
  const slug = match[1];
  if (!slug) {
    throw new Error(`Retained skill path is not a SKILL.md file: ${reference.path}`);
  }
  const source = await store.readSource(reference.packageRevisionId);
  const entry = source?.files[reference.path];
  if (typeof entry !== "string") {
    throw new Error(`Retained skill "${slug}" is missing from package source`);
  }
  return skillListingFromMarkdown(entry, slug);
}
