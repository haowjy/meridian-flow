/**
 * User slash catalog (installed packages ∪ account), model-available catalog
 * (Agent available), preloaded skill bodies (Agent load), and the thread's
 * bound skills with the facts `skillLevel` reads `skills://` by (D52).
 */
import type { RetainedSkillReference } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import { type SkillFacts, skillLevel } from "../../file-policy/index.js";
import {
  type AccountSkillInstallStore,
  type AgentRevisionStore,
  retainedPackageSkillMaps,
  type SkillListing,
  skillListingFromMarkdown,
} from "../../packages/index.js";

const SKILL_MD_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

type UserSkillCatalogStore = Pick<AgentRevisionStore, "listInstallations" | "readSource">;

/** A skill body to inject, and whether the model can read its files under `skills://`. */
export interface LoadedSkill extends SkillListing {
  readable: boolean;
}

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

/** The skills a thread's own binding names, by name, and the facts `skillLevel` decides on. */
export interface ThreadSkills {
  facts: SkillFacts;
  bound: ReadonlyMap<string, RetainedSkillReference>;
}

/**
 * Every skill the thread's binding names (`load` and `available`), from one
 * binding read (D52). Empty when the thread has no binding.
 */
export async function readThreadSkills(
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">,
  threadId: string,
): Promise<ThreadSkills> {
  const binding = await agentRevisions.readThreadBinding(threadId);
  const bound = new Map<string, RetainedSkillReference>();
  if (!binding) return { facts: { load: [], available: [] }, bound };
  const { load, available } = binding.configuration.skills;
  for (const reference of [...load, ...available]) {
    const slug = skillSlugFromPath(reference.path);
    if (!bound.has(slug)) bound.set(slug, reference);
  }
  const offered = [];
  for (const reference of available) {
    const listing = await listingFromBoundReference(agentRevisions, reference);
    offered.push({ slug: listing.slug, modelInvocable: listing.modelInvocable });
  }
  return {
    facts: { load: load.map((reference) => skillSlugFromPath(reference.path)), available: offered },
    bound,
  };
}

/**
 * Bodies of the thread's preloaded skills (`skills.load`), read from its own
 * binding. Preloading is the Agent author's choice, so `model-invocable` does
 * not gate it, and a preloaded skill's files are readable under `skills://`.
 */
export async function resolveThreadPreloadedSkills(input: {
  thread: Thread;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<LoadedSkill[]> {
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!binding) return [];
  const loaded: LoadedSkill[] = [];
  for (const reference of binding.configuration.skills.load) {
    loaded.push({
      ...(await listingFromBoundReference(input.agentRevisions, reference)),
      readable: true,
    });
  }
  return loaded;
}

export function unavailableActivatedSkillSlugs(
  available: readonly AvailableSkillListing[],
  requested: readonly string[],
): string[] {
  const allowed = new Set(available.map((skill) => skill.slug));
  return requested.filter((slug) => !allowed.has(slug));
}

/**
 * A writer `/skill` body. Activation doesn't make the skill's files readable:
 * its header names `skills://` only when the thread's binding already does.
 */
export async function loadUserSkillBody(input: {
  thread: Thread;
  slug: string;
  agentRevisions: UserSkillCatalogStore & Pick<AgentRevisionStore, "readThreadBinding">;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
}): Promise<LoadedSkill> {
  if (input.thread.kind === "primary") {
    const packaged = await readInstalledPackageSkill(
      input.agentRevisions,
      input.thread.userId,
      input.slug,
    );
    if (packaged) {
      if (!packaged.userInvocable) throw new SkillUnavailableError(input.slug);
      const { facts } = await readThreadSkills(input.agentRevisions, input.thread.id);
      return { ...packaged, readable: skillLevel(facts, input.slug) === "read" };
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
        readable: false,
      };
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
  const seen = new Set<string>();
  for (const installation of await installedPackageHeads(store, ownerUserId)) {
    for (const skills of (
      await retainedPackageSkillMaps(installation.currentRevisionId, store)
    ).values()) {
      for (const [slug, reference] of skills) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        const listing = await listingFromBoundReference(store, reference);
        listings.push({
          slug,
          name: listing.name,
          description: listing.description,
          userInvocable: listing.userInvocable,
        });
      }
    }
  }
  return listings;
}

async function readInstalledPackageSkill(
  store: UserSkillCatalogStore,
  ownerUserId: string,
  slug: string,
): Promise<SkillListing | undefined> {
  for (const installation of await installedPackageHeads(store, ownerUserId)) {
    for (const skills of (
      await retainedPackageSkillMaps(installation.currentRevisionId, store)
    ).values()) {
      const reference = skills.get(slug);
      if (reference) return listingFromBoundReference(store, reference);
    }
  }
  return undefined;
}

async function installedPackageHeads(store: UserSkillCatalogStore, ownerUserId: string) {
  return [
    ...(await store.listInstallations(null)),
    ...(await store.listInstallations(ownerUserId)),
  ];
}

async function listingFromBoundReference(
  store: Pick<AgentRevisionStore, "readSource">,
  reference: RetainedSkillReference,
): Promise<SkillListing> {
  const slug = skillSlugFromPath(reference.path);
  const source = await store.readSource(reference.packageRevisionId);
  const entry = source?.files[reference.path];
  if (!source || typeof entry !== "string") {
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
