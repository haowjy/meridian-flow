/** The model's reads: each goes to the live core or the thread's core over its Work draft. */
import {
  type AgentEditCore,
  parseDocumentAddress,
  type ReadCommand,
  type WriteContext,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import { draftOwnerKey, type LinkView } from "@meridian/contracts";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { FileDestination } from "../../file-policy/index.js";
import type { LiveAgentEditCore, RoutedReadContext } from "./agent-edit-cores.js";
import type { WorkViews } from "./agent-edit-runtime.js";
import type { Branches } from "./branches.js";
import { DraftNotFoundError } from "./draft-resolver.js";
import { runWithInversePrincipal } from "./inverse-principal.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";

export type AgentEditRouter = {
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
  /**
   * The room copy a read of this document would see: the thread's Work draft when it has one
   * and the read is a draft read, else live. The caller disposes it.
   */
  readRoom(input: {
    documentId: DocumentId;
    threadId?: ThreadId | null;
    live: boolean;
  }): ReturnType<AgentEditCore["readRoom"]>;
};

export function createAgentEditRouter(input: {
  branches: Pick<Branches, "viewForOwner">;
  drafts: Pick<ApplicationDraftStore, "resolveWorkDraftForThread">;
  liveUtilityCore: LiveAgentEditCore;
  threadCore(threadId: ThreadId): AgentEditCore;
  /** Suggestion mode (prototype): a drafted read is Live through the Work's view. */
  workView?: WorkViews | null;
}): AgentEditRouter {
  /** The thread's Work draft of the document a draft read can show, if it has one. */
  async function workDraftFor(documentId: DocumentId, threadId: string): Promise<string | null> {
    try {
      return (await input.drafts.resolveWorkDraftForThread(documentId, threadId as ThreadId))
        .draftId;
    } catch (cause) {
      if (cause instanceof DraftNotFoundError) return null;
      throw cause;
    }
  }

  /** A read never makes a branch or a draft: a draft read of a document with no Work draft reads live. */
  async function routeRead(request: {
    documentId: DocumentId | null;
    threadId?: string | null;
    version: "live" | "draft";
  }): Promise<{ core: AgentEditCore; workDraftId?: string }> {
    const { documentId, threadId, version } = request;
    const workDraftId =
      version === "draft" && documentId && threadId
        ? await workDraftFor(documentId, threadId)
        : null;
    return workDraftId && threadId
      ? { core: input.threadCore(threadId as ThreadId), workDraftId }
      : { core: input.liveUtilityCore };
  }

  async function routedTo(
    context: WriteContext,
    destination: FileDestination,
  ): Promise<WriteContext & { linkView: LinkView }> {
    const linkView =
      destination.kind === "live"
        ? ({ kind: "live" } as const)
        : await input.branches.viewForOwner(destination.owner);
    return { ...context, linkView, documentVersion: destination.kind };
  }

  return {
    async read(command, routed) {
      const { grant, liveVersion, ...context } = routed;
      const version = liveVersion ? "live" : grant.destination.kind;
      if (input.workView && version === "draft" && grant.destination.kind === "draft") {
        const destination = grant.destination;
        const outcome = await input
          .workView(draftOwnerKey(destination.owner), null)
          .core.read(command, {
            ...context,
            linkView: { kind: "live" },
            documentVersion: "live",
            ...(command.format === "edits" ? { frontiers: undefined } : {}),
          });
        const read = !outcome.isError ? outcome.result.read : undefined;
        return read
          ? {
              ...outcome,
              result: {
                ...outcome.result,
                read: {
                  ...read,
                  version: "draft" as const,
                  draftWork: destination.ownerHandle ?? "/",
                },
              },
            }
          : outcome;
      }
      const { core, workDraftId } = await routeRead({
        documentId: documentIdFromCommand(command),
        threadId: context.threadId,
        version,
      });
      const destination = version === "live" ? ({ kind: "live" } as const) : grant.destination;
      // A move out of a never-drafted source (Scratch) shows live text at a path only the Work's
      // draft has; the grant's facts say so, so the label needs no lookup.
      const parsed = parseUnifiedContextUri(command.file);
      const draftedPath =
        !liveVersion &&
        destination.kind === "live" &&
        grant.facts.scheme !== grant.facts.contentScheme &&
        parsed.ok &&
        parsed.value.scheme === grant.facts.scheme;
      const label =
        destination.kind === "draft"
          ? { version: "draft" as const, draftWork: destination.ownerHandle ?? "/" }
          : draftedPath
            ? { version: "draft" as const, draftWork: grant.facts.ownerWork?.handle ?? "/" }
            : { version: "live" as const };
      const routedContext = {
        ...(await routedTo(context, destination)),
        documentVersion: version,
        ...(workDraftId ? { workDraftId } : {}),
      };
      // An edits read shows history, not the document: it records no frontier.
      const readCore = () =>
        core.read(
          command,
          command.format === "edits" ? { ...routedContext, frontiers: undefined } : routedContext,
        );
      const outcome =
        command.format === "edits"
          ? await runWithInversePrincipal(grant.principal, readCore)
          : await readCore();
      if (outcome.isError) return outcome;
      const read = outcome.result.read;
      return read
        ? {
            ...outcome,
            result: {
              ...outcome.result,
              read: {
                ...read,
                ...label,
              },
            },
          }
        : outcome;
    },

    async readRoom({ documentId, threadId, live }) {
      const { core, workDraftId } = await routeRead({
        documentId,
        threadId,
        version: live ? "live" : "draft",
      });
      return core.readRoom(documentId, workDraftId ? { workDraftId } : {});
    },
  };
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}
