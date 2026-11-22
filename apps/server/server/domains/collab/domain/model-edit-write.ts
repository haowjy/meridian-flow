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
import type { LiveAgentEditCore, RoutedWriteOutcome } from "./agent-edit-cores.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import { runWithInversePrincipal } from "./inverse-principal.js";
import { runInLockedWrite } from "./locked-write.js";
import type { ModelEdits, ModelEditWriteContext } from "./model-edit.js";

/** A write's context without its grant, which the router takes apart. */
type GivenContext = Omit<ModelEditWriteContext, "grant">;

/** What a model edit's write needs from the rest of collab; the seams here are the adapters'. */
export type ModelEditWriteDeps = {
  liveCore: LiveAgentEditCore;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  /** The seam a Live write enters first: the grants' Works, then the document's lock. */
  enterLiveSeam(documentId: DocumentId): Promise<void>;
};

/**
 * Every write lands in Live while drafts are off: a grant whose destination is a draft (an explicit
 * draft target) writes Live too, as `destinationAt` sends every other one (phase 2 routes it to the
 * draft's fork).
 */
export function createModelEditWriter(deps: ModelEditWriteDeps): ModelEdits["write"] {
  async function live(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
  ): Promise<WriteOutcome> {
    if (documentId) {
      await deps.enterLiveSeam(documentId);
      await testHook("command.afterLock");
    }
    return deps.liveCore.write(command, { ...given, linkView: { kind: "live" } });
  }

  return (command, routed: ModelEditWriteContext): Promise<RoutedWriteOutcome> => {
    const { grant, ...given } = routed;
    const documentId = documentIdFromCommand(command);
    return runInLockedWrite(async () => {
      // An inverse takes its own locks in the turn-inverse service.
      if (command.command === "undo" || command.command === "revert") {
        return runWithInversePrincipal(grant.principal, () =>
          deps.liveCore.write(command, { ...given, linkView: { kind: "live" } }),
        );
      }
      const confirmed = await runWithEditGrants(deps.fileAccess, [grant], () =>
        live(command, given, documentId),
      );
      if (!confirmed.ok) throw confirmed.refusal;
      return confirmed.value;
    });
  };
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}

/** A read inside a model edit's command: the locked section's rules, so it pulls nothing. */
export function createModelEditRead(read: AgentEditRouter["read"]): ModelEdits["read"] {
  return (command, context) => runInLockedWrite(() => read(command, context));
}
