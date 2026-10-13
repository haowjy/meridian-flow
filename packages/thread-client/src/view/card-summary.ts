/** card-summary: the words a custom-block card shows by itself (its title and outcome), read from its props. */
import { parseInvocationCard } from "@meridian/contracts/components";
import type { Block } from "@meridian/contracts/protocol";
import { componentBlockContent } from "./component-block-content";
import type { DirectInvocationResult } from "./invocation-direct-result";

export type CardSummary = {
  kind: string;
  /** A subagent card's agent; null for other cards. */
  agentName: string | null;
  /** The title the card draws: a launch's title, a question's text, a form's prompt. Null when it has none (the app words a fallback). */
  title: string | null;
  /** How a launch settled, as the card states it (the direct result wins once the tool settled). */
  outcome: string | null;
};

export function cardSummary(
  block: Block,
  direct: DirectInvocationResult | null,
): CardSummary | null {
  if (block.blockType !== "custom") return null;
  const content = componentBlockContent(block.content);
  if (!content) return null;
  const invocation = parseInvocationCard(content);
  if (invocation)
    return {
      kind: content.kind,
      agentName: invocation.agentName ?? null,
      title: invocation.title ?? null,
      outcome: direct?.outcome ?? invocation.outcome ?? null,
    };
  const props = content.props as Record<string, unknown>;
  const text = props.question ?? props.prompt ?? props.title;
  return {
    kind: content.kind,
    agentName: null,
    title: typeof text === "string" ? text : null,
    outcome: typeof props.resolvedValue === "string" ? props.resolvedValue : null,
  };
}
