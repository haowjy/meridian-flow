// Model inverse entry points expose only prepared leases and accepted host-owned cuts.
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import { toDocHandle } from "../handles.js";
import { renderedItems, shownEvidence } from "../links/shown.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { ModelInverseCommand } from "../ports/document-edits.js";
import { openCommandLinks } from "./command-links.js";
import type { InternalWriteResult } from "./internal-result.js";
import { withObservation } from "./observation.js";
import { renderReceipt } from "./receipt.js";
import type { ResponseCommitter } from "./response-committer.js";
import { status } from "./response-format.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { ReadCommand, WriteContext } from "./types.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import { parseFileAddress } from "./write-helpers.js";

export function createDocumentEditCommands(deps: {
  options: CreateWriteToolOptions;
  committer: ResponseCommitter;
  runtimeStore: RuntimeStore;
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
    // The same prepare gate owns every response-content exposure. The inverse
    // plans against locked authority, never against the helper or a fake journal.
    const lease = context.responseIdentity?.editScopeId
      ? await deps.committer.prepare(context.responseIdentity?.editScopeId, address.documentId)
      : null;
    lease?.dispose();
    const request = { documentId: address.documentId, threadId: session.threadId, context };
    const result =
      "command" in command
        ? await port.execute({ ...request, command })
        : await port.read({ ...request, command });
    if (result.status !== "success") return status(result.status, result.message);
    if (!("command" in command))
      return {
        status: "success",
        phase: "committed",
        model: { message: result.message, read: { format: "edits" } },
      };

    // `after` is the cut the inverse committed on top of, in the version it ran on: the echo
    // records there, crediting nothing when it degraded.
    const observe = result.after ? await context.observeInverse?.(result.draftId) : undefined;
    const before = new Y.Doc({ gc: false }),
      after = new Y.Doc({ gc: false });
    const observed = (rendered: InternalWriteResult) =>
      withObservation(
        rendered,
        after,
        observe,
        address.documentId,
        deps.options.onObservationFailed,
      );
    try {
      await deps.runtimeStore.evictThreadRuntimes(address.documentId, session.threadId, {
        markLiveDocStale: true,
      });
      if (!result.before || !result.after)
        throw new Error("Accepted inverse is missing its content cuts");
      Y.applyUpdate(before, result.before);
      Y.applyUpdate(after, result.after);
      const links = await openCommandLinks(deps.options, {
        documentId: address.documentId,
        docs: [before, after],
        context,
      });
      const beforeBlocks = snapshotBlocks(toDocHandle(before), deps.options.model, links.codec);
      const afterBlocks = snapshotBlocks(toDocHandle(after), deps.options.model, links.codec);
      const beforeByHash = new Map(beforeBlocks.map((block) => [block.hash, block.serialized]));
      const afterHashes = new Set(afterBlocks.map((block) => block.hash));
      const receipt = renderReceipt(
        {
          commandName: command.command,
          writeId: result.writeId ?? "",
          durableWriteId: result.actionId,
          touchedHashes: new Set(
            afterBlocks
              .filter((block) => beforeByHash.get(block.hash) !== block.serialized)
              .map((block) => block.hash),
          ),
          deletedHashes: new Set(
            beforeBlocks.filter((block) => !afterHashes.has(block.hash)).map((block) => block.hash),
          ),
        },
        beforeBlocks,
        afterBlocks,
        { phase: "committed", ...(result.writeId ? { writeId: result.writeId } : {}) },
      );
      return observed({
        ...receipt,
        ...shownEvidence(renderedItems(receipt.model), links),
        revision: deps.options.links.revision(after, links.scope),
        model: { ...receipt.model, message: result.message },
      });
    } catch {
      // Admission has already succeeded; an echo failure cannot turn it into a refusal.
      return observed({
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
