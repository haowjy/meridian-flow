/** The model's reads: Live, or Live through the reading chat's draft view. */
import type { AgentEditCore, ReadCommand, WriteOutcome } from "@meridian/agent-edit/integration";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { LiveAgentEditCore, RoutedReadContext } from "./agent-edit-cores.js";
import type { DraftViews } from "./agent-edit-runtime.js";
import { runWithInversePrincipal } from "./inverse-principal.js";

export type AgentEditRouter = {
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
  /** The live room copy of a document. The caller disposes it. */
  readRoom(input: { documentId: DocumentId }): ReturnType<AgentEditCore["readRoom"]>;
};

export function createAgentEditRouter(input: {
  liveUtilityCore: LiveAgentEditCore;
  /** A drafted read is Live through the draft's view; its links spell in the draft's tree. */
  draftView: DraftViews;
}): AgentEditRouter {
  return {
    async read(command, routed) {
      const { grant, liveVersion, ...context } = routed;
      const version = liveVersion ? "live" : grant.destination.kind;
      if (version === "draft" && grant.destination.kind === "draft") {
        const destination = grant.destination;
        const outcome = await input.draftView
          .core(destination.draftId, {
            chat: context.threadId ?? null,
            turn: null,
            by: "agent",
          })
          .read(command, {
            ...context,
            linkView: { kind: "draft", draftId: destination.draftId },
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
      // A move out of a never-drafted source (Scratch) shows live text at a path only the Work's
      // draft has; the grant's facts say so, so the label needs no lookup.
      const parsed = parseUnifiedContextUri(command.file);
      const draftedPath =
        !liveVersion &&
        grant.facts.scheme !== grant.facts.contentScheme &&
        parsed.ok &&
        parsed.value.scheme === grant.facts.scheme;
      const label = draftedPath
        ? { version: "draft" as const, draftWork: grant.facts.ownerWork?.handle ?? "/" }
        : { version: "live" as const };
      const routedContext = { ...context, linkView: { kind: "live" } as const };
      // An edits read shows history, not the document: it records no frontier.
      const readCore = () =>
        input.liveUtilityCore.read(
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

    readRoom: ({ documentId }) => input.liveUtilityCore.readRoom(documentId),
  };
}
