import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { type McpConnectionView, mcpAddressProblem } from "@meridian/contracts/mcp";

export type ConnectionAction = "try_again" | "add_token" | "update_token" | "choose_tools";

export type ConnectionStanding =
  | { kind: "checking" }
  | { kind: "working"; tools: number }
  | { kind: "no_tools" }
  | { kind: "problem"; status: "unreachable" }
  | { kind: "problem"; status: "needs_sign_in"; tokenSet: boolean }
  | { kind: "shadowed" };

export function connectionStanding(
  connection: McpConnectionView,
  checking = false,
): ConnectionStanding {
  if (connection.shadowedBy) return { kind: "shadowed" };
  if (checking || connection.status === null) return { kind: "checking" };
  if (connection.status === "unreachable") return { kind: "problem", status: "unreachable" };
  if (connection.status === "needs_sign_in")
    return {
      kind: "problem",
      status: "needs_sign_in",
      tokenSet: connection.tokenSet,
    };
  return connection.pin
    ? { kind: "working", tools: connection.pin.tools.length }
    : { kind: "no_tools" };
}

export function problemWord(status: "unreachable" | "needs_sign_in"): string {
  return status === "unreachable" ? t`Unreachable` : t`Needs sign-in`;
}

export function standingAction(standing: ConnectionStanding): ConnectionAction | null {
  if (standing.kind === "no_tools") return "choose_tools";
  if (standing.kind !== "problem") return null;
  if (standing.status === "unreachable") return "try_again";
  return standing.tokenSet ? "update_token" : "add_token";
}

export function actionLabel(action: ConnectionAction): string {
  switch (action) {
    case "try_again":
      return t`Try again`;
    case "add_token":
      return t`Add a token`;
    case "update_token":
      return t`Update the token`;
    case "choose_tools":
      return t`Choose tools`;
  }
}

export function toolCount(count: number): string {
  return plural(count, { one: "# tool", other: "# tools" });
}

export function timeAgo(iso: string, nowMs: number): string {
  const seconds = Math.round((Date.parse(iso) - nowMs) / 1000);
  const format = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" });
  if (seconds > -60) return t`just now`;
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export function suggestedName(address: string): string {
  let host: string;
  try {
    host = new URL(address.trim()).hostname;
  } catch {
    return "";
  }
  const labels = host.split(".").filter((label) => label && !/^(www|api|mcp)$/i.test(label));
  return (labels[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 40);
}

export function addressRefusal(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  const problem = mcpAddressProblem(url);
  if (problem === null) return null;
  return problem === "not_https" ? t`Needs an https address` : t`Needs port 443`;
}
