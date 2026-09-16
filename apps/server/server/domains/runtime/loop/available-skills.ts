/** Available skill union for a primary chat: bound Agent available plus account installs. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { createSkillAvailableNotice, type NoticePort } from "../../notices/index.js";
import {
  type AccountSkillInstallStore,
  type AgentRevisionStore,
  type BoundAgentRevision,
  skillListingFromMarkdown,
} from "../../packages/index.js";

const SKILL_MD_PATH = /^skills\/([^/]+)\/SKILL\.md$/;

export interface AvailableSkillListing {
  slug: string;
  name: string;
  description: string;
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
  const agentSkills = binding ? await listBoundAvailableSkills(input.agentRevisions, binding) : [];
  const accountSkills = (await input.accountSkillInstalls.listByOwner(input.thread.userId)).map(
    (row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
    }),
  );
  return unionAvailableSkills(agentSkills, accountSkills);
}

export async function recordNewlyAvailableSkillNotices(input: {
  threadId: ThreadId;
  available: readonly AvailableSkillListing[];
  bakedSkillSlugs: string[] | null | undefined;
  noticedSkillSlugs: readonly string[] | undefined;
  notices: Pick<NoticePort, "record">;
  markSkillSlugsNoticed: (threadId: ThreadId, slugs: string[]) => Promise<string[]>;
}): Promise<void> {
  if (input.bakedSkillSlugs == null) return;
  const baked = new Set(input.bakedSkillSlugs);
  const noticed = new Set(input.noticedSkillSlugs ?? []);
  const candidates = input.available.filter(
    (skill) => !baked.has(skill.slug) && !noticed.has(skill.slug),
  );
  if (candidates.length === 0) return;
  const fresh = new Set(
    await input.markSkillSlugsNoticed(
      input.threadId,
      candidates.map((skill) => skill.slug),
    ),
  );
  for (const skill of candidates) {
    if (!fresh.has(skill.slug)) continue;
    await input.notices.record(
      createSkillAvailableNotice({
        threadId: input.threadId,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
      }),
    );
  }
}

async function listBoundAvailableSkills(
  store: Pick<AgentRevisionStore, "readSource">,
  binding: BoundAgentRevision,
): Promise<AvailableSkillListing[]> {
  const listings: AvailableSkillListing[] = [];
  for (const reference of binding.configuration.skills.available) {
    const match = SKILL_MD_PATH.exec(reference.path);
    if (!match) {
      throw new Error(`Retained skill path is not a SKILL.md file: ${reference.path}`);
    }
    const slug = match[1];
    const source = await store.readSource(reference.packageRevisionId);
    const entry = source?.files[reference.path];
    if (typeof entry !== "string") {
      throw new Error(`Retained skill "${slug}" is missing from package source`);
    }
    const listing = skillListingFromMarkdown(entry, slug);
    listings.push({
      slug: listing.slug,
      name: listing.name,
      description: listing.description,
    });
  }
  return listings;
}
