/** User slash catalog (installed packages ∪ account) and model-available catalog (Agent available). */
import type { RetainedSkillReference } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import {
  type AccountSkillInstallStore,
  type AgentRevisionStore,
  type BoundAgentRevision,
  retainedPackageSkillMaps,
  type SkillListing,
  skillListingFromMarkdown,
} from "../../packages/index.js";

const SKILL_MD_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

type UserSkillCatalogStore = Pick<AgentRevisionStore, "listInstallations" | "readSource">;

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

export async function resolveThreadUserInvocableSkills(input: {
  thread: Thread;
  agentRevisions: UserSkillCatalogStore;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<AvailableSkillListing[]> {
  if (input.thread.kind !== "primary") return [];
  return listUserInvocableSkills({
    ownerUserId: input.thread.userId,
    agentRevisions: input.agentRevisions,
    accountSkillInstalls: input.accountSkillInstalls,
  });
}

/** Home / creation composer: valid Agent selection is required; rows come from installed packages ∪ account. */
export async function resolveSelectionUserInvocableSkills(input: {
  userId: string;
  catalogEntryId: string;
  definitionRevisionId: string;
  projectId?: string;
  agentRevisions: Pick<AgentRevisionStore, "readSelection" | "listInstallations" | "readSource">;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<AvailableSkillListing[] | null> {
  const selected = await input.agentRevisions.readSelection(
    input.userId,
    input.catalogEntryId,
    input.definitionRevisionId,
    input.projectId,
  );
  if (!selected) return null;
  return listUserInvocableSkills({
    ownerUserId: input.userId,
    agentRevisions: input.agentRevisions,
    accountSkillInstalls: input.accountSkillInstalls,
  });
}

export async function resolveThreadModelAvailableSkills(input: {
  thread: Thread;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<AvailableSkillListing[]> {
  if (input.thread.kind !== "primary") return [];
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!binding) return [];
  const listings: AvailableSkillListing[] = [];
  for (const reference of binding.configuration.skills.available) {
    const listing = await listingFromBoundReference(input.agentRevisions, reference);
    if (!listing.modelInvocable) continue;
    listings.push({
      slug: listing.slug,
      name: listing.name,
      description: listing.description,
    });
  }
  return listings;
}

export function unavailableActivatedSkillSlugs(
  available: readonly AvailableSkillListing[],
  requested: readonly string[],
): string[] {
  const allowed = new Set(available.map((skill) => skill.slug));
  return requested.filter((slug) => !allowed.has(slug));
}

export async function loadUserSkillBody(input: {
  thread: Thread;
  slug: string;
  agentRevisions: UserSkillCatalogStore;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<SkillListing> {
  if (input.thread.kind === "primary") {
    const packaged = await readInstalledPackageSkill(
      input.agentRevisions,
      input.thread.userId,
      input.slug,
    );
    if (packaged) {
      if (!packaged.userInvocable) throw new SkillUnavailableError(input.slug);
      return packaged;
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
        userInvocable: true,
        modelInvocable: true,
      };
    }
  }
  throw new SkillUnavailableError(input.slug);
}

export async function loadModelSkillBody(input: {
  thread: Thread;
  slug: string;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<SkillListing> {
  if (input.thread.kind === "primary") {
    const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
    if (binding) {
      const modelSkill = await readBoundAvailableSkill(input.agentRevisions, binding, input.slug);
      if (modelSkill) {
        if (!modelSkill.modelInvocable) throw new SkillUnavailableError(input.slug);
        return modelSkill;
      }
    }
  }
  throw new SkillUnavailableError(input.slug);
}

async function listUserInvocableSkills(input: {
  ownerUserId: string;
  agentRevisions: UserSkillCatalogStore;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<AvailableSkillListing[]> {
  const packaged = await listInstalledPackageSkills(input.agentRevisions, input.ownerUserId);
  const packagedSlugs = new Set(packaged.map((skill) => skill.slug));
  const account = (await input.accountSkillInstalls.listByOwner(input.ownerUserId))
    .filter((row) => !packagedSlugs.has(row.slug))
    .map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
      userInvocable: true,
    }));
  return [...packaged, ...account]
    .filter((skill) => skill.userInvocable)
    .map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    }));
}

async function listInstalledPackageSkills(
  store: UserSkillCatalogStore,
  ownerUserId: string,
): Promise<Array<AvailableSkillListing & { userInvocable: boolean }>> {
  const listings: Array<AvailableSkillListing & { userInvocable: boolean }> = [];
  for await (const listing of firstInstalledPackageSkills(store, ownerUserId)) {
    listings.push({
      slug: listing.slug,
      name: listing.name,
      description: listing.description,
      userInvocable: listing.userInvocable,
    });
  }
  return listings;
}

async function readInstalledPackageSkill(
  store: UserSkillCatalogStore,
  ownerUserId: string,
  slug: string,
): Promise<SkillListing | undefined> {
  for await (const listing of firstInstalledPackageSkills(store, ownerUserId)) {
    if (listing.slug === slug) return listing;
  }
  return undefined;
}

async function* firstInstalledPackageSkills(
  store: UserSkillCatalogStore,
  ownerUserId: string,
): AsyncGenerator<SkillListing> {
  const seen = new Set<string>();
  for (const installation of [
    ...(await store.listInstallations(null)),
    ...(await store.listInstallations(ownerUserId)),
  ]) {
    for (const skills of (
      await retainedPackageSkillMaps(installation.currentRevisionId, store)
    ).values()) {
      for (const [slug, reference] of skills) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        yield await listingFromBoundReference(store, reference);
      }
    }
  }
}

async function readBoundAvailableSkill(
  store: Pick<AgentRevisionStore, "readSource">,
  binding: BoundAgentRevision,
  slug: string,
): Promise<SkillListing | undefined> {
  for (const reference of binding.configuration.skills.available) {
    if (skillSlugFromPath(reference.path) !== slug) continue;
    return listingFromBoundReference(store, reference);
  }
  return undefined;
}

async function listingFromBoundReference(
  store: Pick<AgentRevisionStore, "readSource">,
  reference: RetainedSkillReference,
): Promise<SkillListing> {
  const slug = skillSlugFromPath(reference.path);
  const source = await store.readSource(reference.packageRevisionId);
  const entry = source?.files[reference.path];
  if (typeof entry !== "string") {
    throw new Error(`Retained skill "${slug}" is missing from package source`);
  }
  return skillListingFromMarkdown(entry, slug);
}

function skillSlugFromPath(path: string): string {
  const match = SKILL_MD_PATH.exec(path);
  const slug = match?.[1];
  if (!slug) {
    throw new Error(`Retained skill path is not a SKILL.md file: ${path}`);
  }
  return slug;
}
