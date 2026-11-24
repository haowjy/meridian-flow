/**
 * A model edit's write: read, plan, lower and commit in one critical section under the lock the
 * commit takes (the seam's Work locks, then the document's lock), inside
 * the command transaction `modelEdits().run` opened. Planning under the lock is what keeps a writer's undo from landing between a plan and
 * its append, so the receipt never claims text a tombstone already covers.
 */
import {
  parseDocumentAddress,
  type WriteCommand,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { testHook } from "../../../shared/test-hooks.js";
import { runWithEditGrants } from "../../file-policy/edit-confirmation.js";
import type { FileAccess } from "../../file-policy/index.js";
import type { AgentEditCore } from "./agent-edit-cores.js";
import { linkViewOf } from "./agent-edit-router.js";
import type { ModelEdits, ModelEditWriteContext } from "./model-edit.js";

/** What a model edit's write needs from the rest of collab; the seams here are the adapters'. */
export type ModelEditWriteDeps = {
  core: AgentEditCore;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  /** The seam a write enters first: the grants' Works, then the document's lock. */
  enterSeam(documentId: DocumentId): Promise<void>;
};

/**
 * A write lands at its grant's destination: Live, or the chat's draft, whose fork room the host
 * picks (`agentRoomFor`). Links spell in that destination's tree.
 */
export function createModelEditWriter(deps: ModelEditWriteDeps): ModelEdits["write"] {
  async function write(
    command: WriteCommand,
    given: ModelEditWriteContext,
    documentId: DocumentId | null,
  ): Promise<WriteOutcome> {
    if (documentId) {
      await deps.enterSeam(documentId);
      await testHook("command.afterLock");
    }
    return deps.core.write(command, given);
  }

  return async (command, routed: ModelEditWriteContext): Promise<WriteOutcome> => {
    const given = { ...routed, linkView: linkViewOf(routed.grant.destination) };
    // An inverse takes its own locks in the turn-inverse service.
    if (command.command === "undo" || command.command === "revert")
      return deps.core.write(command, given);
    const confirmed = await runWithEditGrants(deps.fileAccess, [routed.grant], () =>
      write(command, given, documentIdFromCommand(command)),
    );
    if (!confirmed.ok) throw confirmed.refusal;
    return confirmed.value;
  };
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}
