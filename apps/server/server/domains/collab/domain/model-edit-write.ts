/**
 * A model edit's write: read, plan, lower and append in one critical section under the lock the
 * append takes (the seam's Work locks, a drafted write's draft, then the document's lock), inside
 * the command transaction `modelEdits().run` opened. Planning under the lock is what keeps a writer's undo from landing between a plan and
 * its append, so the receipt never claims text a tombstone already covers.
 */
import {
  parseDocumentAddress,
  type WriteCommand,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { approveDraftWriteJoin } from "../../../shared/draft-write-join.js";
import { testHook } from "../../../shared/test-hooks.js";
import { runWithEditGrants } from "../../file-policy/edit-confirmation.js";
import { agentDraftOwner, type FileAccess, type FileGrant } from "../../file-policy/index.js";
import type { LiveAgentEditCore, RoutedWriteOutcome } from "./agent-edit-cores.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import type { DraftViews } from "./agent-edit-runtime.js";
import type { Drafts } from "./drafts.js";
import { runWithInversePrincipal } from "./inverse-principal.js";
import { runInLockedWrite } from "./locked-write.js";
import type { ModelEdits, ModelEditWriteContext } from "./model-edit.js";

/** A write's context without its grant, which the router takes apart. */
type GivenContext = Omit<ModelEditWriteContext, "grant">;

/** What a model edit's write needs from the rest of collab; the seams here are the adapters'. */
export type ModelEditWriteDeps = {
  liveCore: LiveAgentEditCore;
  /** A draft's view of Live: a drafted write goes into Live as the draft's suggestions. */
  draftView: DraftViews;
  drafts: Pick<Drafts, "lockForWrite">;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  /** The seam a live journal append enters first: the grants' Works, then the document's lock. */
  enterLiveSeam(documentId: DocumentId): Promise<void>;
  /** A drafted write's first locks: the grants' Works and lineages, then their confirmation. */
  enterDraftSeam(): Promise<void>;
  /**
   * The document exists only in this draft (its create is pending there). Its text is plain: the
   * pending create is its whole pending state.
   */
  existsOnlyIn(documentId: DocumentId, draft: DraftId): Promise<boolean>;
};

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

  /**
   * A drafted write: Live's door, as the agent's draft's suggestions. Its owner is locked first,
   * refusing a closed one, then the draft.
   */
  async function suggest(
    command: WriteCommand,
    given: GivenContext,
    documentId: DocumentId | null,
    grant: FileGrant<"edit">,
  ): Promise<WriteOutcome> {
    await deps.enterDraftSeam();
    approveDraftWriteJoin();
    const draft = (await deps.drafts.lockForWrite(agentDraftOwner(grant.principal).owner)).id;
    if (documentId) {
      await deps.enterLiveSeam(documentId);
      await testHook("command.afterLock");
    }
    const turn =
      given.turnId ?? (given.actor?.kind === "agent" ? given.actor.turnId : null) ?? null;
    const core =
      documentId && (await deps.existsOnlyIn(documentId, draft))
        ? deps.draftView.onlyIn(draft)
        : deps.draftView.core(draft, { chat: given.threadId ?? null, turn, by: "agent" });
    return core.write(command, { ...given, linkView: { kind: "draft", draftId: draft } });
  }

  return (command, routed: ModelEditWriteContext): Promise<RoutedWriteOutcome> => {
    const { grant, ...given } = routed;
    const documentId = documentIdFromCommand(command);
    return runInLockedWrite(async () => {
      // An inverse takes its own locks in the turn-inverse service. A drafted one reads its echo
      // in the draft's view, where the suggestions it took back show.
      if (command.command === "undo" || command.command === "revert") {
        const drafted = grant.destination.kind === "live" ? null : grant.destination.draftId;
        const linkView: LinkView = drafted ? { kind: "draft", draftId: drafted } : { kind: "live" };
        const core = drafted
          ? deps.draftView.core(drafted, {
              chat: given.threadId ?? null,
              turn: given.turnId ?? null,
              by: "agent",
            })
          : deps.liveCore;
        return runWithInversePrincipal(grant.principal, () =>
          core.write(command, { ...given, linkView }),
        );
      }
      const confirmed = await runWithEditGrants(deps.fileAccess, [grant], () =>
        grant.destination.kind === "live"
          ? live(command, given, documentId)
          : suggest(command, given, documentId, grant),
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
