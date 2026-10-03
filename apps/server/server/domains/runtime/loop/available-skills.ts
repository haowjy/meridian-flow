/**
 * User slash catalog (installed packages ∪ account), model-available catalog
 * (Agent available), preloaded skill bodies (Agent load), and the resource
 * files that ship beside a bound skill's SKILL.md.
 */
import { posix } from "node:path";
import type { RetainedSkillReference } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import {
  type AccountSkillInstallStore,
  type AgentRevisionBinding,
  type AgentRevisionStore,
  retainedPackageSkillMaps,
  type SkillListing,
  skillListingFromMarkdown,
} from "../../packages/index.js";

const SKILL_MD_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

type UserSkillCatalogStore = Pick<AgentRevisionStore, "listInstallations" | "readSource">;

/** A bound skill with the UTF-8 files beside its SKILL.md, as paths relative to the skill. */
export interface LoadedSkill extends SkillListing {
  resources: string[];
}

export interface AvailableSkillListing {
  slug: string;
  name: string;
  description: string;
}

/** A resource the skill doesn't ship, or a path that leaves the skill's directory. */
export class SkillResourceError extends Error {
  readonly name = "SkillResourceError";
}

export class SkillUnavailableError extends Error {
  readonly name = "SkillUnavailableError";

  /** `loadable` is the model's own catalog, named so a refused load points at what will work. */
  constructor(slug: string, loadable?: readonly string[]) {
    super(
      loadable === undefined
        ? `Skill "${slug}" is not available`
        : `Skill "${slug}" is not available. ${
            loadable.length > 0
              ? `Skills you can load: ${loadable.join(", ")}.`
              : "This agent has no skills to load."
          }`,
    );
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

/**
 * Bodies of the thread's preloaded skills (`skills.load`), read from its own
 * binding. Preloading is the Agent author's choice, so `model-invocable` does
 * not gate it; that flag only governs the `skill` tool.
 */
export async function resolveThreadPreloadedSkills(input: {
  thread: Thread;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<LoadedSkill[]> {
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!binding) return [];
  const loaded: LoadedSkill[] = [];
  for (const reference of binding.configuration.skills.load) {
    loaded.push(await listingFromBoundReference(input.agentRevisions, reference));
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
 * A writer `/skill` body. Its resources are the ones the model can open on
 * this thread, so an activated skill the Agent can't load lists none.
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
      return { ...packaged, resources: await modelSkillResources(input) };
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
        resources: [],
      };
    }
  }
  throw new SkillUnavailableError(input.slug);
}

export async function loadModelSkillBody(input: {
  thread: Thread;
  slug: string;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<LoadedSkill> {
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (binding) {
    const modelSkill = await readBoundAvailableSkill(input.agentRevisions, binding, input.slug);
    if (modelSkill?.modelInvocable) return modelSkill;
  }
  throw await modelSkillUnavailable(input);
}

/**
 * Text of one file beside a skill's SKILL.md. The agent may open resources of
 * any skill whose body it can have: model-loadable `available` skills and its
 * preloaded `load` skills.
 */
export async function loadModelSkillResource(input: {
  thread: Thread;
  slug: string;
  resource: string;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<string> {
  const reference = await resourceReadableReference(input);
  if (!reference) throw await modelSkillUnavailable(input);
  const skill = await listingFromBoundReference(input.agentRevisions, reference);
  const relative = posix.normalize(input.resource);
  if (
    posix.isAbsolute(input.resource) ||
    input.resource.includes("\\") ||
    relative === ".." ||
    relative.startsWith("../")
  ) {
    throw new SkillResourceError(`Resource "${input.resource}" is outside skill "${input.slug}".`);
  }
  if (skill.resources.includes(relative)) {
    const source = await input.agentRevisions.readSource(reference.packageRevisionId);
    const entry = source?.files[`${posix.dirname(reference.path)}/${relative}`];
    if (typeof entry === "string") return entry;
  }
  throw new SkillResourceError(
    `Skill "${input.slug}" has no resource "${input.resource}". ${
      skill.resources.length > 0
        ? `Its resources: ${skill.resources.join(", ")}.`
        : "It has no resources."
    }`,
  );
}

/** Resources the model may open for `slug` on this thread; [] when it can't load that skill. */
export async function modelSkillResources(input: {
  thread: Thread;
  slug: string;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<string[]> {
  const reference = await resourceReadableReference(input);
  if (!reference) return [];
  return (await listingFromBoundReference(input.agentRevisions, reference)).resources;
}

async function resourceReadableReference(input: {
  thread: Thread;
  slug: string;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<RetainedSkillReference | undefined> {
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!binding) return undefined;
  const preloaded = binding.configuration.skills.load.find(
    (reference) => skillSlugFromPath(reference.path) === input.slug,
  );
  if (preloaded) return preloaded;
  const available = binding.configuration.skills.available.find(
    (reference) => skillSlugFromPath(reference.path) === input.slug,
  );
  if (!available) return undefined;
  const listing = await listingFromBoundReference(input.agentRevisions, available);
  return listing.modelInvocable ? available : undefined;
}

async function modelSkillUnavailable(input: {
  thread: Thread;
  slug: string;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">;
}): Promise<SkillUnavailableError> {
  const loadable = await resolveThreadModelAvailableSkills(input);
  return new SkillUnavailableError(
    input.slug,
    loadable.map((skill) => skill.slug),
  );
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
): Promise<LoadedSkill | undefined> {
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

async function readBoundAvailableSkill(
  store: Pick<AgentRevisionStore, "readSource">,
  binding: AgentRevisionBinding,
  slug: string,
): Promise<LoadedSkill | undefined> {
  for (const reference of binding.configuration.skills.available) {
    if (skillSlugFromPath(reference.path) !== slug) continue;
    return listingFromBoundReference(store, reference);
  }
  return undefined;
}

async function listingFromBoundReference(
  store: Pick<AgentRevisionStore, "readSource">,
  reference: RetainedSkillReference,
): Promise<LoadedSkill> {
  const slug = skillSlugFromPath(reference.path);
  const source = await store.readSource(reference.packageRevisionId);
  const entry = source?.files[reference.path];
  if (!source || typeof entry !== "string") {
    throw new Error(`Retained skill "${slug}" is missing from package source`);
  }
  const directory = `${posix.dirname(reference.path)}/`;
  const resources = Object.entries(source.files)
    .filter(
      ([path, file]) =>
        path.startsWith(directory) && path !== reference.path && typeof file === "string",
    )
    .map(([path]) => path.slice(directory.length))
    .sort();
  return { ...skillListingFromMarkdown(entry, slug), resources };
}

function skillSlugFromPath(path: string): string {
  const match = SKILL_MD_PATH.exec(path);
  const slug = match?.[1];
  if (!slug) {
    throw new Error(`Retained skill path is not a SKILL.md file: ${path}`);
  }
  return slug;
}
