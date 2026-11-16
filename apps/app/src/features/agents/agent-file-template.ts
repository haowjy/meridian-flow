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

/** Mars's browser build, started once on first use. */
let marsSchema: Promise<typeof import("@meridian-flow/mars-schema")> | undefined;
const loadMars = () =>
  (marsSchema ??= import("@meridian-flow/mars-schema").then(async (mars) => {
    const init = (mars as { default?: unknown }).default;
    if (typeof init === "function") await init();
    return mars;
  }));

/**
 * The text a new file at an Agent or skill path starts with: frontmatter Mars reads without a
 * finding, so the file is available the moment it is made. The name goes through Mars's own
 * emitter, so a name that reads as a number or a list (`123`, `[critic]`) is quoted. Null for any
 * other path.
 */
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
    // Only `mode: primary` starts a chat; a new Agent is one the writer means to talk to.
    ...(file.kind === "agent" ? [["mode", "primary"] as [string, string]] : []),
  ])}---\n\n`;
  return file.kind === "agent"
    ? `${frontmatter}You are ${file.slug}. Write what you do here.\n`
    : `${frontmatter}Write the steps of ${file.slug} here.\n`;
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

/** Writes the template of the Agent or skill file at `levelPath` as a just-made document's first text. */
export async function writeFirstAgentText(
  registry: Parameters<typeof writeFirstText>[0],
  projectId: string,
  documentId: string,
  levelPath: string,
): Promise<void> {
  const template = await agentFileTemplate(levelPath);
  if (template) await writeFirstText(registry, projectId, documentId, template);
}
