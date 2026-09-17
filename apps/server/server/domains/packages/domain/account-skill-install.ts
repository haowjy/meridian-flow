/** Copy a retained launch-agents skill into the account install store. */
import type { UserId } from "@meridian/contracts/runtime";
import type { AccountSkillInstallStore } from "../ports/account-skill-install-store.js";
import type { AgentRevisionStore } from "../ports/agent-revision-store.js";
import type { SkillFiles } from "./skill-files.js";
import { skillListingFromMarkdown } from "./skill-listing.js";

export class PackagedSkillNotFoundError extends Error {
  readonly name = "PackagedSkillNotFoundError";

  constructor(slug: string) {
    super(`No retained launch-agents skill named "${slug}"`);
  }
}

export async function installPackagedAccountSkill(input: {
  installs: AccountSkillInstallStore;
  agentRevisions: AgentRevisionStore;
  ownerUserId: UserId;
  slug: string;
}): Promise<Awaited<ReturnType<AccountSkillInstallStore["insert"]>>> {
  const packaged = await readPackagedSkill(input.agentRevisions, input.slug);
  if (!packaged) throw new PackagedSkillNotFoundError(input.slug);
  return input.installs.insert({
    ownerUserId: input.ownerUserId,
    slug: input.slug,
    name: packaged.name,
    description: packaged.description,
    body: packaged.body,
  });
}

async function readPackagedSkill(
  agentRevisions: AgentRevisionStore,
  slug: string,
): Promise<{ name: string; description: string; body: string } | undefined> {
  const path = `skills/${slug}/SKILL.md`;
  for (const installation of await agentRevisions.listInstallations(null)) {
    const source = await agentRevisions.readSource(installation.currentRevisionId);
    const parsed = parsePackagedSkillFile(source?.files, path, slug);
    if (parsed) return parsed;
  }
  return undefined;
}

function parsePackagedSkillFile(
  files: SkillFiles | undefined,
  path: string,
  slug: string,
): { name: string; description: string; body: string } | undefined {
  const entry = files?.[path];
  if (typeof entry !== "string") return undefined;
  return skillListingFromMarkdown(entry, slug);
}
