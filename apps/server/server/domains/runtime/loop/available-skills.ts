/**
 * User slash catalog (built-in, user and project levels), model-available catalog
 * (Agent available), preloaded skill bodies (Agent load), and the thread's
 * bound and user-invoked skills with the facts `skillLevel` reads
 * `skills://` by.
 */
import type { RetainedSkillReference } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/threads";
import type { SkillFacts } from "../../file-policy/index.js";
import {
  type AgentRevisionBinding,
  type AgentRevisionStore,
  type BoundAgentCatalog,
  type SkillListing,
  skillListingFromMarkdown,
} from "../../packages/index.js";

// Retained package paths are the on-disk Mars format, not Context document names.
const SKILL_MD_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

/** A skill body to inject, and whether the model can read its files under `skills://`. */
interface LoadedSkill extends SkillListing {
  readable: boolean;
}

export interface AvailableSkillListing {
  slug: string;
  name: string;
  description: string;
}

class SkillUnavailableError extends Error {
  readonly name = "SkillUnavailableError";

  constructor(slug: string) {
    super(`Skill "${slug}" is not available`);
  }
}

export async function resolveThreadUserInvocableSkills(input: {
  thread: Thread;
  agentCatalog: Pick<BoundAgentCatalog, "userSkills">;
}): Promise<AvailableSkillListing[]> {
  if (input.thread.kind !== "primary") return [];
  const skills = await input.agentCatalog.userSkills(input.thread.userId, {
    projectId: input.thread.projectId,
  });
  return skills.map(({ slug, name, description }) => ({ slug, name, description }));
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

/** The skills a thread can name, with the reference each is read from, and the facts `skillLevel` decides on. */
interface ThreadSkills {
  facts: SkillFacts;
  bound: ReadonlyMap<string, RetainedSkillReference>;
}

/**
 * Every skill the thread's binding names (`load` and `available`) and every
 * packaged skill its user invoked, from one binding read. A slug
 * both bound and invoked keeps the binding's reference. Empty when the thread
 * has no binding.
 */
export async function readThreadSkills(
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource">,
  threadId: string,
): Promise<ThreadSkills> {
  const binding = await agentRevisions.readThreadBinding(threadId);
  const bound = new Map<string, RetainedSkillReference>();
  if (!binding) return { facts: { load: [], available: [], invoked: [] }, bound };
  const { load, available } = binding.configuration.skills;
  for (const reference of [...load, ...available]) {
    const slug = skillSlugFromPath(reference.path);
    if (!bound.has(slug)) bound.set(slug, reference);
  }
  for (const [slug, reference] of Object.entries(binding.invokedSkills)) {
    if (!bound.has(slug)) bound.set(slug, reference);
  }
  const offered = [];
  for (const reference of available) {
    const listing = await listingFromBoundReference(agentRevisions, reference);
    offered.push({ slug: listing.slug, modelInvocable: listing.modelInvocable });
  }
  return {
    facts: {
      load: load.map((reference) => skillSlugFromPath(reference.path)),
      available: offered,
      invoked: Object.keys(binding.invokedSkills),
    },
    bound,
  };
}

/** Whether a thread can see a skill at all, so it is offered the `skill` tool. */
export function bindingNamesSkills(
  binding: Pick<AgentRevisionBinding, "configuration" | "invokedSkills">,
): boolean {
  const { load, available } = binding.configuration.skills;
  return load.length > 0 || available.length > 0 || Object.keys(binding.invokedSkills).length > 0;
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
 * A writer `/skill` body. Invoking a skill pins the files it was read from on the thread, so
 * they are readable for the rest of the thread and its header names `skills://`; invoking it
 * again reads the pinned files.
 */
export async function loadUserSkillBody(input: {
  thread: Thread;
  slug: string;
  agentRevisions: Pick<
    AgentRevisionStore,
    "recordInvokedSkill" | "readThreadBinding" | "readSource"
  >;
  agentCatalog: Pick<BoundAgentCatalog, "resolveSkill">;
}): Promise<LoadedSkill> {
  if (input.thread.kind === "primary") {
    // A skill invoked before keeps the files it was first read from; refreshing is a separate act.
    const pinned = (await input.agentRevisions.readThreadBinding(input.thread.id))?.invokedSkills[
      input.slug
    ];
    if (pinned) {
      return { ...(await listingFromBoundReference(input.agentRevisions, pinned)), readable: true };
    }
    const found = await input.agentCatalog.resolveSkill(input.thread.userId, {
      projectId: input.thread.projectId,
      slug: input.slug,
    });
    if (found) {
      const readable = await input.agentRevisions.recordInvokedSkill(
        input.thread.id,
        input.slug,
        found.reference,
      );
      return { ...found.skill, readable };
    }
  }
  throw new SkillUnavailableError(input.slug);
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
    throw new Error(`Retained skill path is not a skill definition: ${path}`);
  }
  return slug;
}
