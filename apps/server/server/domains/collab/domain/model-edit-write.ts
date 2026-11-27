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
import { runAtDestination } from "./agent-destination.js";
import type { AgentEditCore, RoutedWriteOutcome } from "./agent-edit-cores.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import { runWithInversePrincipal } from "./inverse-principal.js";
import { runInLockedWrite } from "./locked-write.js";
import type { ModelEdits, ModelEditWriteContext } from "./model-edit.js";

type GivenContext = Omit<ModelEditWriteContext, "grant">;

export type ModelEditWriteDeps = {
  core: AgentEditCore;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  /** The seam a write enters first: the grants' Works, then the document's lock. */
  enterSeam(documentId: DocumentId): Promise<void>;
};

export function createModelEditWriter(deps: ModelEditWriteDeps): ModelEdits["write"] {
  async function write(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
  ): Promise<WriteOutcome> {
    if (documentId) {
      await deps.enterSeam(documentId);
      await testHook("command.afterLock");
    }
    return deps.core.write(command, given);
  }

  return (command, routed: ModelEditWriteContext): Promise<RoutedWriteOutcome> => {
    const { grant, ...rest } = routed;
    const { destination } = grant;
    const given = {
      ...rest,
      linkView:
        destination.kind === "draft"
          ? ({ kind: "draft", draftId: destination.draftId } as const)
          : ({ kind: "live" } as const),
    };
    const documentId = documentIdFromCommand(command);
    return runInLockedWrite(() =>
      runAtDestination(destination, async () => {
        // An inverse takes its own locks in the turn-inverse service.
        if (command.command === "undo" || command.command === "revert") {
          return runWithInversePrincipal(grant.principal, () => deps.core.write(command, given));
        }
        const confirmed = await runWithEditGrants(deps.fileAccess, [grant], () =>
          write(command, given, documentId),
        );
        if (!confirmed.ok) throw confirmed.refusal;
        return confirmed.value;
      }),
    );
  };
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}

export function createModelEditRead(read: AgentEditRouter["read"]): ModelEdits["read"] {
  return (command, context) => runInLockedWrite(() => read(command, context));
}
