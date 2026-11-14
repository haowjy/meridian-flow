import {
  createAgentEditCodecFactory,
  overwriteWithAssigned,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { agentsFileOf } from "@meridian/contracts/agents";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";

/**
 * The text a new file at an Agent or skill path starts with: frontmatter Mars reads without a
 * finding, so the file is available the moment it is made. Null for any other path.
 */
export function agentFileTemplate(levelPath: string): string | null {
  const file = agentsFileOf(levelPath);
  if (!file) return null;
  return file.kind === "agent"
    ? `---\nname: ${file.slug}\ndescription: What ${file.slug} does, and when to pick it.\n---\n\nYou are ${file.slug}. Write what you do here.\n`
    : `---\nname: ${file.slug}\ndescription: When to use ${file.slug}.\n---\n\nWrite the steps of ${file.slug} here.\n`;
}

/**
 * Writes a just-made document's first text into its local copy, as typing would: the room sends
 * it when the server has the create. A document that already holds text keeps it.
 */
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
    if (session.document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).length > 0) return;
    const schema = buildDocumentSchema();
    const codec = createAgentEditCodecFactory(mdxCodec({ schema }));
    overwriteWithAssigned({
      doc: session.document,
      model: yProsemirrorModel(schema),
      codec: codec.forScope(UNSCOPED_DOCUMENT_LINKS),
      documentId,
      content: text,
      blocks: [schema.nodes.code_block.create({ language: "source" }, schema.text(text))],
    });
  } finally {
    registry.release(owner);
  }
}
