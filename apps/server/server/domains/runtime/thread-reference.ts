/** Frozen pointers to prior conversations, shared by spawn seeds and handoff briefs. */
import type { ThreadReferenceProps } from "@meridian/contracts/components";
import type { BlockUpsertedRow, Thread } from "@meridian/contracts/threads";

export function threadReferenceText(source: {
  ref: string;
  title?: string | null;
  agentName?: string | null;
  lastActivityAt?: string;
}): string {
  const title = source.title ? JSON.stringify(source.title) : "";
  const agent = source.agentName ? ` (Agent: ${source.agentName})` : "";
  const activity = source.lastActivityAt
    ? `last active ${source.lastActivityAt.slice(0, 16).replace("T", " ")} UTC`
    : "";
  const args = JSON.stringify({ ref: source.ref });
  const details = [`${title}${agent}`.trim(), activity].filter(Boolean).join(", ");
  return `<thread_reference ref="${source.ref}">${details ? `\n${details}. ` : ""}Not included here; read it with thread_history(${args}).${details ? "\n" : ""}</thread_reference>`;
}

export function threadReferenceBlock(source: Thread): BlockUpsertedRow {
  // resolveReadableThread only admits persisted, parsed refs.
  const ref = source.ref as string;
  const props: Omit<ThreadReferenceProps, "text"> = {
    threadId: source.id,
    ref,
    title: source.title,
    agentName: source.agentName,
    lastActivityAt: source.lastActivityAt,
  };
  return {
    id: crypto.randomUUID(),
    // The seed's owning turn and final sequence are assigned by persistWriterTurn.
    turnId: "",
    sequence: 0,
    blockType: "custom",
    status: "complete",
    content: { kind: "thread-reference", props: { ...props, text: threadReferenceText(props) } },
  };
}
