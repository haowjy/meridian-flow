import { agentsFileOf } from "@meridian/contracts/agents";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { newBlockId } from "@meridian/prosemirror-schema";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { roomContent, roomSchema } from "@/core/editor/room-content";
import { loadMars } from "@/lib/mars-schema";

export async function agentFileTemplate(levelPath: string): Promise<string | null> {
  const file = agentsFileOf(levelPath);
  if (!file) return null;
  const { rewriteBlock } = await loadMars();
  const describe =
    file.kind === "agent"
      ? `What ${file.slug} does, and when to pick it.`
      : `When to use ${file.slug}.`;
  const frontmatter = `---\n${rewriteBlock([
    ["name", file.slug],
    ["description", describe],
    ...(file.kind === "agent" ? [["mode", "primary"] as [string, string]] : []),
  ])}---\n\n`;
  return file.kind === "agent"
    ? `${frontmatter}You are ${file.slug}. Write what you do here.\n`
    : `${frontmatter}Write the steps of ${file.slug} here.\n`;
}

export async function writeFirstText(
  registry: Pick<LiveDocumentSessionRegistry, "admit" | "get" | "retain" | "release">,
  projectId: string,
  documentId: string,
  text: string,
): Promise<void> {
  const lease = registry.admit(projectId as ProjectId, documentId as DocumentId);
  const owner = `first-text:${documentId}`;
  registry.retain(owner, [lease]);
  try {
    const session = registry.get(lease);
    await session.whenLocalPersistenceSynced();
    if (roomContent(session.docs).textContent.length > 0) return;
    const schema = roomSchema();
    session.writeDocument(
      schema.nodes.doc.create(null, [
        schema.nodes.code_block.create({ id: newBlockId(), language: "source" }, schema.text(text)),
      ]),
    );
  } finally {
    registry.release(owner);
  }
}

export async function writeFirstAgentText(
  registry: Parameters<typeof writeFirstText>[0],
  projectId: string,
  documentId: string,
  levelPath: string,
): Promise<void> {
  const template = await agentFileTemplate(levelPath);
  if (template) await writeFirstText(registry, projectId, documentId, template);
}
