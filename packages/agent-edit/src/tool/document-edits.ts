// Model inverse entry points: accepted host-owned cuts, rendered and recorded in the room they ran in.
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { ModelInverseCommand } from "../ports/document-edits.js";
import { openCommandLinks } from "./command-links.js";
import type { InternalWriteResult } from "./internal-result.js";
import { recordObservation } from "./observation.js";
import { renderReceipt } from "./receipt.js";
import type { ResponseCommitter } from "./response-committer.js";
import { status } from "./response-format.js";
import type { ReadCommand, WriteContext } from "./types.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import { parseFileAddress } from "./write-helpers.js";

export function createDocumentEditCommands(deps: {
  options: CreateWriteToolOptions;
  committer: ResponseCommitter;
}) {
  return async (
    command: ReadCommand | ModelInverseCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> => {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (
      context.responseIdentity?.editScopeId &&
      deps.committer.hasBufferedWrites(context.responseIdentity?.editScopeId)
    )
      throw new Error("Immutable edit commands require the reply save boundary");
    const port = deps.options.documentEdits;
    if (!port) return status("invalid_write", "This host has no immutable edit history.");
    // The inverse plans against the host's locked authority, never against a call's room copy.
    const request = { documentId: address.documentId, threadId: session.threadId, context };
    const result =
      "command" in command
        ? await port.execute({ ...request, command })
        : await port.read({ ...request, command });
    if (result.status !== "success") return status(result.status, result.message);
    if ("command" in command && result.updates)
      context.frontiers?.reply?.append(address.documentId, result.updates);
    if (!("command" in command))
      return {
        status: "success",
        phase: "committed",
        model: { message: result.message, read: { format: "edits" } },
      };

    // `after` is the cut the inverse committed on top of, in the room it ran in: the echo
    // records there, crediting nothing when it degraded.
    const before = new Y.Doc({ gc: false }),
      after = new Y.Doc({ gc: false });
    let links: Awaited<ReturnType<typeof openCommandLinks>> | undefined;
    let ownRemoved: Set<string> | undefined;
    const observed = (rendered: InternalWriteResult) =>
      recordObservation(
        rendered,
        {
          doc: after,
          model: deps.options.model,
          ...(links ? { links } : {}),
          ...(ownRemoved ? { ownRemoved } : {}),
        },
        result.after ? result.room : null,
        context.frontiers?.recording,
        address.documentId,
        deps.options.onObservationFailed,
      );
    try {
      if (!result.before || !result.after)
        throw new Error("Accepted inverse is missing its content cuts");
      Y.applyUpdate(before, result.before);
      Y.applyUpdate(after, result.after);
      links = await openCommandLinks(deps.options, {
        documentId: address.documentId,
        docs: [before, after],
        context,
      });
      const beforeBlocks = snapshotBlocks(toDocHandle(before), deps.options.model, links.codec);
      const afterBlocks = snapshotBlocks(toDocHandle(after), deps.options.model, links.codec);
      const blockId = (block: { clientID: number; clock: number }) =>
        `${block.clientID}:${block.clock}`;
      const beforeById = new Map(beforeBlocks.map((block) => [blockId(block), block.body]));
      const afterIds = new Set(afterBlocks.map(blockId));
      const deletedBlocks = beforeBlocks.filter((block) => !afterIds.has(blockId(block)));
      ownRemoved = new Set(deletedBlocks.map(blockId));
      const receipt = renderReceipt(
        {
          commandName: command.command,
          writeId: result.writeId ?? "",
          durableWriteId: result.actionId,
          touchedBlocks: afterBlocks.filter(
            (block) => beforeById.get(blockId(block)) !== block.body,
          ),
          deletedBlocks,
        },
        beforeBlocks,
        afterBlocks,
        { phase: "committed", ...(result.writeId ? { writeId: result.writeId } : {}) },
      );
      return await observed({
        ...receipt,
        revision: deps.options.links.revision(after, links.scope),
        model: { ...receipt.model, message: result.message },
      });
    } catch {
      // Admission has already succeeded; an echo failure cannot turn it into a refusal.
      return await observed({
        status: "success",
        phase: "committed",
        ...(result.writeId ? { writeId: result.writeId } : {}),
        model: { message: result.message, awarenessDegraded: true },
      });
    } finally {
      before.destroy();
      after.destroy();
    }
  };
}
