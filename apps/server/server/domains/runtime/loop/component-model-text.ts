/** Projects custom component blocks to the text visible in model context. */
import { type ComponentBlockContent, parseInvocationCard } from "@meridian/contracts/components";

export function componentModelText(content: ComponentBlockContent): string | null {
  if (content.kind === "thread-reference" || content.kind === "handoff-brief") {
    const text = content.kind === "thread-reference" ? content.props.text : content.props.modelText;
    return typeof text === "string" ? text : null;
  }
  if (content.kind !== "helper-result") return null;
  const props = parseInvocationCard(content);
  if (!props || props.terminalAt === null) return null;
  if ("reason" in props) {
    return `Subagent "${props.agentName}" could not start: ${props.reason}`;
  }
  return null;
}

/** Projects a custom card for history without exposing its host-only correlation props. */
export function componentHistoryText(content: ComponentBlockContent): string {
  const modelText = componentModelText(content);
  if (modelText) return modelText;

  const invocation = parseInvocationCard(content);
  if (invocation) {
    if (invocation.terminalAt === null) return `Subagent "${invocation.agentName}" is running.`;
    if ("outcome" in invocation)
      return `Subagent "${invocation.agentName}" finished (${invocation.outcome}).`;
  }

  if (content.kind === "compaction" && typeof content.props.summary === "string") {
    return content.props.summary;
  }
  if (typeof content.props.question === "string") return content.props.question;
  return `[component: ${content.kind}]`;
}
