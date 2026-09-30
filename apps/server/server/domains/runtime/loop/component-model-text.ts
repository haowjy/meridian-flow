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
