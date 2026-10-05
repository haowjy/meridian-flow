/**
 * The action policy (D39): the one place an agent action beyond files is
 * decided allow, ask or deny. File writes go through the file policy instead;
 * the writer's own actions never come here.
 */
import type { AgentPermission } from "@meridian/contracts/agents";
import type { WorkCommand } from "../../tools/core-tools.js";

export type ActionDecision = "allow" | "ask" | "deny";

/** An agent action the policy decides; Work actions are named by their `work` command. */
export type AgentAction = `work.${WorkCommand["command"]}`;

const WORK_CHANGE = { edit: "allow", read: "deny" } as const;
const ALWAYS = { edit: "allow", read: "allow" } as const;
// The model's switch waits on the writer prompt (#601); until then `ask` is refused (D37).
const ASK = { edit: "ask", read: "ask" } as const;

const ACTIONS: Readonly<Record<AgentAction, Readonly<Record<AgentPermission, ActionDecision>>>> = {
  "work.create": WORK_CHANGE,
  "work.update": WORK_CHANGE,
  "work.archive": WORK_CHANGE,
  "work.unarchive": WORK_CHANGE,
  "work.delete": WORK_CHANGE,
  "work.switch": ASK,
  "work.list": ALWAYS,
  "work.show": ALWAYS,
};

/**
 * Decided on the chain's effective permission (`chainPermission`), so a `read`
 * parent caps a default-`edit` child (D35, D39). Every row is monotone
 * (read ≤ edit), so that equals the lowest decision over the chain.
 */
export function actionPolicy(permission: AgentPermission, action: AgentAction): ActionDecision {
  return ACTIONS[action][permission];
}

/** Whether the agent may change Works, so refusal copy may offer `work unarchive`. */
export function mayChangeWorks(permission: AgentPermission): boolean {
  return actionPolicy(permission, "work.unarchive") === "allow";
}

/** What the model reads when the policy refused a `work` command. */
export function workActionRefusal(
  command: WorkCommand,
  decision: Exclude<ActionDecision, "allow">,
): string {
  if (decision === "deny") {
    return "This agent can read but can't change Works. Ask the user to make this change.";
  }
  const target = command.command === "switch" && command.work ? `@${command.work}` : "No Work";
  return `Switching this chat's Work needs the user's approval. Ask them to switch it to ${target} from the chat.`;
}
