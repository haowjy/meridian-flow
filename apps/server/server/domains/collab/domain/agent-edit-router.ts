/**
 * The model's reads: at the grant's destination (Live, or the chat's draft fork), or Live for a
 * `version: "live"` read.
 */
import type { ReadCommand, WriteOutcome } from "@meridian/agent-edit/integration";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { FileDestination } from "../../file-policy/index.js";
import type { AgentEditCore, RoutedReadContext } from "./agent-edit-cores.js";

export type AgentEditRouter = {
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
};

export function createAgentEditRouter(input: { core: AgentEditCore }): AgentEditRouter {
  return {
    async read(command, routed) {
      const { grant, liveVersion } = routed;
      const destination: FileDestination = liveVersion ? { kind: "live" } : grant.destination;
      // A move out of a never-drafted source (Scratch) shows live text at a path only the Work's
      // draft has; the grant's facts say so, so the label needs no lookup.
      const parsed = parseUnifiedContextUri(command.file);
      const draftedPath =
        !liveVersion &&
        grant.facts.scheme !== grant.facts.contentScheme &&
        parsed.ok &&
        parsed.value.scheme === grant.facts.scheme;
      const label =
        destination.kind === "draft"
          ? { version: "draft" as const, draftWork: destination.ownerHandle ?? "/" }
          : draftedPath
            ? { version: "draft" as const, draftWork: grant.facts.ownerWork?.handle ?? "/" }
            : { version: "live" as const };
      const context = { ...routed, linkView: linkViewOf(destination) };
      // An edits read shows history, not the document: it records no frontier.
      const outcome = await input.core.read(
        command,
        command.format === "edits" ? { ...context, frontiers: undefined } : context,
      );
      if (outcome.isError) return outcome;
      const read = outcome.result.read;
      return read
        ? { ...outcome, result: { ...outcome.result, read: { ...read, ...label } } }
        : outcome;
    },
  };
}

/** The link view, and room, a destination names. */
export const linkViewOf = (destination: FileDestination) =>
  destination.kind === "draft"
    ? ({ kind: "draft", draftId: destination.draftId } as const)
    : ({ kind: "live" } as const);
