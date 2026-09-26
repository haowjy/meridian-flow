/** The admitted assistant turn and invocation correlation must describe one real child execution. */
import type { AdmitExecutionReportInput } from "../ports/repositories.js";

type ThreadIdentity = {
  id: string;
  ref: string | null;
  kind: string;
  userId: string;
  projectId: string;
  rootThreadId: string | null;
  parentThreadId: string | null;
};
type TurnIdentity = { id: string; threadId: string; role: string };
type CardIdentity = { turnId: string; blockType: string };

export function assertExecutionReportAdmission(
  input: AdmitExecutionReportInput,
  identity: {
    child: ThreadIdentity | null;
    assistant: TurnIdentity | null;
    caller: ThreadIdentity | null;
    callerTurn: TurnIdentity | null;
    card: CardIdentity | null;
  },
): void {
  const { child, assistant, caller, callerTurn, card } = identity;
  if (
    child?.kind !== "subagent" ||
    child.ref !== input.handle ||
    assistant?.threadId !== child.id ||
    assistant.role !== "assistant"
  )
    throw new Error("Execution report requires the admitted child assistant turn and handle");

  if (input.origin === "thread_run") {
    if (
      input.deliveryMode !== "none" ||
      input.callerThreadId !== null ||
      input.callerTurnId !== null ||
      input.toolCallId !== null ||
      input.cardBlockId !== null
    )
      throw new Error("Thread-run report cannot carry invocation correlation");
    return;
  }
  if (
    (input.origin === "spawn" &&
      input.deliveryMode !== "direct" &&
      input.deliveryMode !== "background_notification") ||
    (input.origin === "foreground_message" && input.deliveryMode !== "direct") ||
    !input.callerThreadId ||
    !input.callerTurnId ||
    !input.toolCallId ||
    !caller ||
    !callerTurn ||
    callerTurn.threadId !== caller.id ||
    caller.userId !== child.userId ||
    caller.projectId !== child.projectId ||
    (caller.rootThreadId ?? caller.id) !== child.rootThreadId ||
    (input.cardBlockId !== null && (card?.turnId !== callerTurn.id || card.blockType !== "custom"))
  )
    throw new Error("Execution report invocation correlation is invalid");
}
