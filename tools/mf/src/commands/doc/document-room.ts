/**
 * A document's first text, written the way an editor writes it: connect to the document's room,
 * wait for its state, and apply the parsed blocks to the synced copy. The tree list makes the
 * document; its content is the room's.
 */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  createAgentEditCodecFactory,
  overwriteWithAssigned,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";
import { yjsSocketOptions } from "../../core/yjs-socket";

const SYNC_TIMEOUT_MS = 15_000;
const STORE_TIMEOUT_MS = 15_000;

/**
 * Writes `markdown` into the room's synced copy and keeps the connection until `stored` says the
 * server holds it: the socket must not close on an update still in flight.
 */
export async function writeMarkdown(
  session: Session,
  documentId: string,
  markdown: string,
  stored: () => Promise<boolean>,
): Promise<void> {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodecFactory(mdxCodec({ schema }));
  const doc = createCollabYDoc({ gc: false });
  const socket = new HocuspocusProviderWebsocket({
    ...yjsSocketOptions(session),
    autoConnect: false,
  });
  let synced!: () => void;
  const ready = new Promise<void>((resolve) => {
    synced = resolve;
  });
  const provider = new HocuspocusProvider({
    name: documentId,
    document: doc,
    websocketProvider: socket,
    onSynced: () => synced(),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    provider.attach();
    void socket.connect();
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CliError(
                "unavailable",
                `The document's room did not sync in ${SYNC_TIMEOUT_MS}ms`,
              ),
            ),
          SYNC_TIMEOUT_MS,
        );
      }),
    ]);
    const parsed = codec.parse(markdown);
    const written = overwriteWithAssigned({
      doc,
      model: yProsemirrorModel(schema),
      codec: codec.forScope(UNSCOPED_DOCUMENT_LINKS),
      documentId,
      content: markdown,
      blocks: parsed.blocks,
    });
    if (!written.ok)
      throw new CliError("http_error", `The document refused its text: ${written.message}`);
    const deadline = Date.now() + STORE_TIMEOUT_MS;
    while (!(await stored())) {
      if (Date.now() > deadline)
        throw new CliError(
          "timeout",
          `The server had not stored the text after ${STORE_TIMEOUT_MS}ms`,
        );
      await new Promise((done) => setTimeout(done, 100));
    }
  } finally {
    clearTimeout(timer);
    provider.destroy();
    socket.destroy();
  }
}
