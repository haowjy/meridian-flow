/**
 * The action policy (D39): the one place an agent action beyond files is
 * decided allow, ask or deny. File writes go through the file policy instead;
 * the writer's own actions never come here.
 */
import type { AgentPermission } from "@meridian/contracts/agents";
import type { PermissionAction } from "@meridian/contracts/threads";
import type { WorkCommand } from "../../tools/core-tools.js";

export type ActionDecision = "allow" | "ask" | "deny";

/** An agent action the policy decides; Work actions are named by their `work` command. */
export type AgentAction = `work.${WorkCommand["command"]}`;

/** The actions a permission request can hold. Any other row that says `ask` fails to compile. */
export type AskableAction = PermissionAction & AgentAction;

type PolicyRow<A extends AgentAction> = Readonly<
  Record<AgentPermission, A extends AskableAction ? ActionDecision : Exclude<ActionDecision, "ask">>
>;

const WORK_CHANGE = { edit: "allow", read: "deny" } as const;
const ALWAYS = { edit: "allow", read: "allow" } as const;

const ACTIONS: { readonly [A in AgentAction]: PolicyRow<A> } = {
  "work.create": WORK_CHANGE,
  "work.update": WORK_CHANGE,
  "work.archive": WORK_CHANGE,
  "work.unarchive": WORK_CHANGE,
  "work.delete": WORK_CHANGE,
  "work.switch": WORK_CHANGE,
  "work.write_mode": WORK_CHANGE,
  "work.list": ALWAYS,
  "work.show": ALWAYS,
};

/**
 * Decided on the chain's effective permission (`chainPermission`), so a `read`
 * parent caps a default-`edit` child (D35, D39). Every row is monotone
 * (read ≤ edit), so that equals the lowest decision over the chain.
 */
export function actionPolicy<A extends AgentAction>(
  permission: AgentPermission,
  action: A,
): PolicyRow<A>[AgentPermission] {
  return ACTIONS[action][permission];
}

/** Whether the agent may change Works, so refusal copy may offer `work unarchive`. */
export function mayChangeWorks(permission: AgentPermission): boolean {
  return actionPolicy(permission, "work.unarchive") === "allow";
}
