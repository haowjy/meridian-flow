/** The model's reads: Live (drafts are off until phase 2 rebuilds them on forks). */
import type { ReadCommand, WriteOutcome } from "@meridian/agent-edit/integration";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { LiveAgentEditCore, RoutedReadContext } from "./agent-edit-cores.js";
import { runWithInversePrincipal } from "./inverse-principal.js";

export type AgentEditRouter = {
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
};

export function createAgentEditRouter(input: { liveCore: LiveAgentEditCore }): AgentEditRouter {
  return {
    async read(command, routed) {
      const { grant, liveVersion, ...context } = routed;
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
        input.liveCore.read(
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
  };
}
