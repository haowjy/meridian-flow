import type { AgentPermission } from "@meridian/contracts/agents";
import type { PermissionAction } from "@meridian/contracts/threads";
import type { WorkCommand } from "../../tools/core-tools.js";

export type ActionDecision = "allow" | "ask" | "deny";

export type AgentAction = `work.${WorkCommand["command"]}`;

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

export function actionPolicy<A extends AgentAction>(
  permission: AgentPermission,
  action: A,
): PolicyRow<A>[AgentPermission] {
  return ACTIONS[action][permission];
}

export function mayChangeWorks(permission: AgentPermission): boolean {
  return actionPolicy(permission, "work.unarchive") === "allow";
}
